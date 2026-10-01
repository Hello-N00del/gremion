// F1-FIX-10-K / K2#7: member add, member remove and the provisioning retry used
// to answer { success: true } (201 / 200) even when the provisioning report said
// a subsystem FAILED, so the admin UI showed a green outcome for a member who has
// no Keycloak group / Matrix room. The committee DELETE already answers 207 with
// success:false in that case; these three follow the same convention. The role
// helper ($lib/auth) is REAL on purpose.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const h = vi.hoisted(() => ({
  addMember: vi.fn(),
  removeMember: vi.fn(),
  provisionOrgUnit: vi.fn(),
  writeAuditEntry: vi.fn(),
}))

vi.mock('$lib/server/governance/provisioning/orchestrator', () => ({
  addMember: h.addMember,
  removeMember: h.removeMember,
  provisionOrgUnit: h.provisionOrgUnit,
}))
vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: vi.fn(async (id: string) => ({ id, name: 'Unit', visibility: 'all_members' })),
  isMemberOf: vi.fn(async () => false),
  listOrgUnitMembers: vi.fn(async () => []),
}))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: h.writeAuditEntry }))
vi.mock('$lib/server/keycloak-admin', () => ({ getKeycloakAdminClient: () => ({ getUser: vi.fn() }) }))

import { POST as addPOST } from './members/+server'
import { DELETE as removeDELETE } from './members/[userId]/+server'
import { POST as provisionPOST } from './provision/+server'

const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }

const report = (overall: 'ok' | 'degraded' | 'failed') => ({
  orgUnitId: 'u1',
  overall,
  subsystems: [{ subsystem: 'keycloak', status: overall === 'ok' ? 'ok' : 'failed', willRetry: true }],
})

function ev(body?: unknown) {
  return {
    params: { id: 'u1', userId: 'kc-user' },
    locals: { auth: async () => ({ user: ADMIN }), tenant: null },
    request: new Request('http://localhost', { method: 'POST', body: JSON.stringify(body ?? {}) }),
  } as never
}

const ADD_BODY = { userKeycloakId: 'kc-user', membershipType: 'unelected', termStart: null, termEnd: null }

beforeEach(() => {
  h.addMember.mockReset()
  h.removeMember.mockReset()
  h.provisionOrgUnit.mockReset()
  h.writeAuditEntry.mockReset().mockResolvedValue(undefined)
})

describe('member add / remove / provision retry report real provisioning outcome (K2#7)', () => {
  it('add: ok report keeps 201 success:true', async () => {
    h.addMember.mockResolvedValue(report('ok'))
    const res = await addPOST(ev(ADD_BODY))
    expect(res.status).toBe(201)
    expect((await res.json()).success).toBe(true)
  })

  it.each(['failed', 'degraded'] as const)('add: a %s report is not success', async (overall) => {
    h.addMember.mockResolvedValue(report(overall))
    const res = await addPOST(ev(ADD_BODY))
    const body = await res.json()
    expect(res.status).toBe(207)
    expect(body.success).toBe(false)
    expect(String(body.error)).toMatch(/Bereitstellung/)
    expect(body.data.report.overall).toBe(overall)
    // the audit entry still records what happened
    expect(h.writeAuditEntry).toHaveBeenCalledTimes(1)
  })

  it('remove: ok report keeps 200 success:true', async () => {
    h.removeMember.mockResolvedValue(report('ok'))
    const res = await removeDELETE(ev())
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it.each(['failed', 'degraded'] as const)('remove: a %s report is not success', async (overall) => {
    h.removeMember.mockResolvedValue(report(overall))
    const res = await removeDELETE(ev())
    const body = await res.json()
    expect(res.status).toBe(207)
    expect(body.success).toBe(false)
    expect(body.data.report.overall).toBe(overall)
  })

  it('provision retry: ok is success, failed is not', async () => {
    h.provisionOrgUnit.mockResolvedValue(report('ok'))
    const ok = await provisionPOST(ev())
    expect(ok.status).toBe(200)
    expect((await ok.json()).success).toBe(true)

    h.provisionOrgUnit.mockResolvedValue(report('failed'))
    const bad = await provisionPOST(ev())
    const body = await bad.json()
    expect(bad.status).toBe(207)
    expect(body.success).toBe(false)
    expect(body.data.overall).toBe('failed')
  })
})
