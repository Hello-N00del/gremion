import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { castBallot, type CastInput } from './cast-service'

describe('castBallot', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('POSTs to the Helios cast endpoint with credentials', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ cast_url: 'http://helios/booth/cast.html?t=abc', audit_url: 'http://helios/booth/audit.html?t=abc' }),
    })

    const input: CastInput = {
      heliosBase: 'http://helios:8000',
      electionUuid: 'election-uuid-1',
      encryptedVote: '{"answers":[]}',
      auditHash: 'sha1hash',
    }
    const result = await castBallot(input)

    expect(mockFetch).toHaveBeenCalledWith(
      'http://helios:8000/helios/elections/election-uuid-1/cast',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
    expect(result.castUrl).toBe('http://helios/booth/cast.html?t=abc')
    expect(result.auditUrl).toBe('http://helios/booth/audit.html?t=abc')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 })
    await expect(
      castBallot({
        heliosBase: 'http://helios:8000',
        electionUuid: 'uuid',
        encryptedVote: '{}',
        auditHash: 'hash',
      }),
    ).rejects.toThrow('Helios cast → 403')
  })
})
