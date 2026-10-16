// @vitest-environment node
//
// R29-RETENTION-30-K [D R29-I6]: PATCH /api/settings refuses retention values
// above the operator ceiling. The old bounds (30 / 90 / 180 / 365, BayLDA and
// BSI tiers) let an admin keep audit rows 180 days; the caps are now 29 d for
// the tiers a daily purge tick enforces (cap + 24 h = 30 d) and 30 d for
// security_nopii_logs_days.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockReadConfig, mockWriteConfig, mockHasRole, mockWriteAudit } = vi.hoisted(() => ({
  mockReadConfig: vi.fn(),
  mockWriteConfig: vi.fn(),
  mockHasRole: vi.fn(),
  mockWriteAudit: vi.fn(),
}))

vi.mock('$lib/server/config', () => ({ readConfig: mockReadConfig, writeConfig: mockWriteConfig }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: mockWriteAudit }))
vi.mock('$lib/auth', () => ({ hasRole: mockHasRole, Role: { ITAdmin: 'it-admin' } }))

import { PATCH } from './+server'

const CURRENT = {
  retention: { access_logs_days: 14, app_logs_days: 28, security_logs_days: 27, security_nopii_logs_days: 27 },
}

function patch(body: unknown) {
  const request = new Request('http://localhost/api/settings', { method: 'PATCH', body: JSON.stringify(body) })
  // @ts-expect-error partial event
  return PATCH({ request, locals: { auth: async () => ({ user: { id: 'u', roles: ['it-admin'] } }) } })
}

beforeEach(() => {
  mockHasRole.mockReturnValue(true)
  mockReadConfig.mockReturnValue(CURRENT)
  mockWriteConfig.mockReset()
  mockWriteConfig.mockReturnValue(CURRENT)
  mockWriteAudit.mockReset()
})

describe('PATCH /api/settings retention caps [D R29-I6]', () => {
  it.each([
    ['security_logs_days', 45],
    ['security_logs_days', 30],
    ['security_logs_days', 90],
    ['app_logs_days', 30],
    ['app_logs_days', 90],
    ['access_logs_days', 30],
    ['security_nopii_logs_days', 31],
    ['security_nopii_logs_days', 365],
  ])('refuses %s = %i (422, nothing written)', async (field, value) => {
    const res = await patch({ retention: { [field]: value } })
    expect(res.status).toBe(422)
    expect(mockWriteConfig).not.toHaveBeenCalled()
    expect(mockWriteAudit).not.toHaveBeenCalled()
  })

  it('names the operator ceiling in the refusal, not a BSI/BayLDA tier', async () => {
    const res = await patch({ retention: { security_logs_days: 45 } })
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('29')
    expect(body.error).toContain('Betreiberentscheidung vom 30.09.2026')
    expect(body.error).not.toContain('R29-I6')
    expect(body.error).not.toContain('BSI')
    expect(body.error).not.toContain('180')
  })

  it.each([
    ['security_logs_days', 29],
    ['security_logs_days', 1],
    ['app_logs_days', 29],
    ['access_logs_days', 29],
    ['security_nopii_logs_days', 30],
  ])('accepts %s = %i at the cap', async (field, value) => {
    const res = await patch({ retention: { [field]: value } })
    expect(res.status).toBe(200)
    expect(mockWriteConfig).toHaveBeenCalledWith({ retention: { [field]: value } })
  })

  it('still refuses 0 and non-integers', async () => {
    expect((await patch({ retention: { security_logs_days: 0 } })).status).toBe(422)
    expect((await patch({ retention: { security_logs_days: 12.5 } })).status).toBe(422)
  })
})
