// A route id that is not a UUID names nothing. The committee pages used to hand it to the
// database driver, which rejects it (SQLSTATE 22P02) and SvelteKit answered 500. Every page
// and action under /members/committees/[id] must answer 404 instead, before any query or
// internal fetch runs. The mocked store rejects a non-UUID exactly like the driver does, so a
// missing guard shows up as a thrown driver error (500), never as a quiet "not found".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth/types'

const UUID = '3f0c8a52-7d1e-4b8a-9c55-0a1b2c3d4e5f'
const PROTOCOL = '9b2d1c40-1f6a-4d0e-8a77-5e4d3c2b1a09'

const h = vi.hoisted(() => {
  const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  const driverError = () => Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' })
  return {
    isUuid,
    getOrgUnit: vi.fn(async (id: string) => {
      if (!isUuid(id)) throw driverError()
      return { id, name: 'Referat', visibility: 'all_members', kind: 'committee' }
    }),
    isMemberOf: vi.fn(async () => true),
    listOrgUnitMembers: vi.fn(async (id: string) => {
      if (!isUuid(id)) throw driverError()
      return []
    }),
  }
})

vi.mock('$lib/server/governance/org-units-db', () => ({
  getOrgUnit: h.getOrgUnit,
  isMemberOf: h.isMemberOf,
  listOrgUnitMembers: h.listOrgUnitMembers,
}))
vi.mock('$lib/server/governance/governance-db', () => ({
  listRoles: vi.fn(async () => []),
  listHistory: vi.fn(async () => []),
  getActiveAssignment: vi.fn(async () => null),
}))
vi.mock('$lib/server/governance/provisioning/ledger', () => ({ getResources: vi.fn(async () => []) }))
vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: () => ({ getUser: vi.fn(async (id: string) => ({ username: id })) }),
}))

const { load: layoutLoad } = await import('./+layout.server')
const { load: protokolleLoad } = await import('./protokolle/+page.server')
const { load: newProtocolLoad, actions: newProtocolActions } = await import('./protokolle/new/+page.server')
const { load: protocolLoad } = await import('./protokolle/[protocolId]/+page.server')

const ADMIN = { id: 'admin', roles: [Role.CouncilAdmin] }

async function statusOf(run: () => unknown): Promise<number | 'ok' | Error> {
  try {
    await run()
    return 'ok'
  } catch (e) {
    const status = (e as { status?: number }).status
    return typeof status === 'number' ? status : (e as Error)
  }
}

const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))

function event(params: Record<string, string>) {
  return {
    params,
    fetch: fetchSpy,
    locals: { user: ADMIN, auth: async () => ({ user: ADMIN }) },
    url: new URL('https://pilot.test/x'),
    parent: async () => ({ committee: { id: params.id } }),
  } as never
}

beforeEach(() => {
  fetchSpy.mockClear()
  h.getOrgUnit.mockClear()
  h.listOrgUnitMembers.mockClear()
})

describe('malformed committee id answers 404', () => {
  it('layout: not-a-uuid is 404 and never reaches the store', async () => {
    expect(await statusOf(() => layoutLoad(event({ id: 'not-a-uuid' })))).toBe(404)
    expect(h.getOrgUnit).not.toHaveBeenCalled()
  })

  it('layout: a well-formed id still resolves', async () => {
    expect(await statusOf(() => layoutLoad(event({ id: UUID })))).toBe('ok')
  })

  it('layout: percent-decoded path-shaped ids answer 404 as well', async () => {
    expect(await statusOf(() => layoutLoad(event({ id: '../clients' })))).toBe(404)
  })

  it('protokolle list: 404 without an internal fetch', async () => {
    expect(await statusOf(() => protokolleLoad(event({ id: 'not-a-uuid' })))).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('new protocol form load: 404 without an internal fetch', async () => {
    expect(await statusOf(() => newProtocolLoad(event({ id: 'not-a-uuid' })))).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('new protocol form action: 404 without an internal fetch (actions skip the layout)', async () => {
    const ev = {
      ...(event({ id: 'not-a-uuid' }) as object),
      request: { formData: async () => new FormData() },
    } as never
    expect(await statusOf(() => newProtocolActions.default(ev))).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('protocol detail: a malformed protocol id is 404 (not the API 400), no internal fetch', async () => {
    expect(await statusOf(() => protocolLoad(event({ id: UUID, protocolId: 'not-a-uuid' })))).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('protocol detail: a malformed committee id is 404 before any roster read', async () => {
    expect(await statusOf(() => protocolLoad(event({ id: 'not-a-uuid', protocolId: PROTOCOL })))).toBe(404)
    expect(h.listOrgUnitMembers).not.toHaveBeenCalled()
  })
})
