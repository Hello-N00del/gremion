// TASK-043 TDD 10 / 14 (unit halves): the realm operations the customer
// lifecycle adds to KcProvisionApi, over a scripted transport.
import { describe, expect, it } from 'vitest'
import { KcProvisionApi, type KcTransport } from './kc-admin-api'

type Call = { method: string; path: string; body?: unknown }

function transportWith(routes: Record<string, unknown | ((call: Call) => unknown)>): { transport: KcTransport; calls: Call[] } {
  const calls: Call[] = []
  const transport: KcTransport = async (method, path, body) => {
    const call = { method, path, body }
    calls.push(call)
    const r = routes[`${method} ${path}`]
    return typeof r === 'function' ? (r as (c: Call) => unknown)(call) : r
  }
  return { transport, calls }
}

const R = '/admin/realms/musterstadt'
const EMAIL = 'it@musterstadt.example'
const USERS = `GET ${R}/users?email=${encodeURIComponent(EMAIL)}&exact=true`

describe('ensureInvitedUser (FLOW-IDN-002, Q9)', () => {
  it('creates the user with UPDATE_PASSWORD + CONFIGURE_TOTP, maps the realm role, sends ONE execute-actions mail and marks it', async () => {
    let createdUser = false
    const { transport, calls } = transportWith({
      [USERS]: () => (createdUser ? [{ id: 'u-1', email: EMAIL }] : []),
      [`POST ${R}/users`]: () => {
        createdUser = true
        return undefined
      },
      [`GET ${R}/roles/it-admin`]: { id: 'r-1', name: 'it-admin' },
    })
    const r = await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'it-admin' }, () => '2026-09-30T00:00:00.000Z')
    expect(r).toEqual({ id: 'u-1', created: true, invited: true })
    const create = calls.find((c) => c.method === 'POST' && c.path === `${R}/users`)!
    expect(create.body).toMatchObject({ username: EMAIL, email: EMAIL, enabled: true, requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'] })
    // never an operator-set password (Q9)
    expect(create.body).not.toHaveProperty('credentials')
    expect(create.body).not.toHaveProperty('password')
    expect(calls).toContainEqual({ method: 'POST', path: `${R}/users/u-1/role-mappings/realm`, body: [{ id: 'r-1', name: 'it-admin' }] })
    const mails = calls.filter((c) => c.path.startsWith(`${R}/users/u-1/execute-actions-email`))
    expect(mails).toHaveLength(1)
    expect(mails[0]!.body).toEqual(['UPDATE_PASSWORD', 'CONFIGURE_TOTP'])
    expect(calls).toContainEqual({ method: 'PUT', path: `${R}/users/u-1`, body: { attributes: { gremion_invited_at: ['2026-09-30T00:00:00.000Z'] } } })
  })

  it('adopts a user that already exists and was invited: no create, no mail', async () => {
    const { transport, calls } = transportWith({
      [USERS]: [{ id: 'u-1', email: EMAIL, attributes: { gremion_invited_at: ['2026-09-29T00:00:00.000Z'] } }],
      [`GET ${R}/roles/it-admin`]: { id: 'r-1', name: 'it-admin' },
    })
    const r = await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'it-admin' })
    expect(r).toEqual({ id: 'u-1', created: false, invited: false })
    expect(calls.some((c) => c.method === 'POST' && c.path === `${R}/users`)).toBe(false)
    expect(calls.some((c) => c.path.includes('execute-actions-email'))).toBe(false)
  })

  it('adopts a 409 on create and still invites a user that was never invited (crash between create and send)', async () => {
    let lookups = 0
    const { transport, calls } = transportWith({
      [USERS]: () => (lookups++ === 0 ? [] : [{ id: 'u-2', email: EMAIL }]),
      [`POST ${R}/users`]: () => {
        throw new Error('Keycloak Admin API error: 409 on POST /users: exists')
      },
      [`GET ${R}/roles/council-admin`]: { id: 'r-2', name: 'council-admin' },
    })
    const r = await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'council-admin' })
    expect(r).toEqual({ id: 'u-2', created: false, invited: true })
    expect(calls.filter((c) => c.path.includes('execute-actions-email'))).toHaveLength(1)
  })

  it('a missing realm role is a loud failure, not a user without a role', async () => {
    const { transport } = transportWith({ [USERS]: [{ id: 'u-1', email: EMAIL }] })
    await expect(new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'it-admin' })).rejects.toThrow(/realm role "it-admin" not found/)
  })
})

describe('setRealmEnabled / isRealmEnabled / getRealmSmtp (suspend, resume, R-E5b)', () => {
  it('suspend: enabled false with notBefore now, then logout-all', async () => {
    const { transport, calls } = transportWith({})
    await new KcProvisionApi(transport).setRealmEnabled('musterstadt', false, 1_800_000_000)
    expect(calls).toEqual([
      { method: 'PUT', path: R, body: { realm: 'musterstadt', enabled: false, notBefore: 1_800_000_000 } },
      { method: 'POST', path: `${R}/logout-all`, body: undefined },
    ])
  })

  it('resume: enabled true only', async () => {
    const { transport, calls } = transportWith({})
    await new KcProvisionApi(transport).setRealmEnabled('musterstadt', true)
    expect(calls).toEqual([{ method: 'PUT', path: R, body: { realm: 'musterstadt', enabled: true } }])
  })

  it('reads enabled and the non-secret smtp fields (a set password only as passwordSet)', async () => {
    const { transport } = transportWith({
      [`GET ${R}`]: {
        enabled: true,
        smtpServer: { host: 'mail.platform.example', port: '587', user: 'kc-musterstadt@platform.example', from: 'kc-musterstadt@platform.example', starttls: 'true', password: '**********' },
      },
    })
    const api = new KcProvisionApi(transport)
    expect(await api.isRealmEnabled('musterstadt')).toBe(true)
    const s = await api.getRealmSmtp('musterstadt')
    expect(s).toEqual({ host: 'mail.platform.example', port: '587', user: 'kc-musterstadt@platform.example', from: 'kc-musterstadt@platform.example', starttls: 'true', passwordSet: true })
    expect(JSON.stringify(s)).not.toContain('*****')
  })
})
