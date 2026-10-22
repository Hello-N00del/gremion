// TASK-043 TDD 10 / 14 (unit halves): the realm operations the customer
// lifecycle adds to KcProvisionApi, over a scripted transport.
import { describe, expect, it } from 'vitest'
import { KcProvisionApi, type KcTransport } from './kc-admin-api'

type Call = { method: string; path: string; body?: unknown }

// A route is a canned response or a function of the call (both are `unknown`).
function transportWith(routes: Record<string, unknown>): { transport: KcTransport; calls: Call[] } {
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

// Keycloak 26's default user profile: four managed attributes, unmanaged
// attributes DISABLED (an undeclared attribute is dropped on write).
const DEFAULT_PROFILE = {
  attributes: [{ name: 'username' }, { name: 'email' }, { name: 'firstName' }, { name: 'lastName' }],
  groups: [{ name: 'user-metadata' }],
}

/** A user store that keeps what a PUT writes, so a read-back sees it (or not). */
function userStore(id: string, opts: { dropUndeclared?: boolean } = {}) {
  let user: Record<string, unknown> = { id, username: EMAIL, email: EMAIL, firstName: 'Ina', enabled: true, attributes: {} }
  return {
    get: () => user,
    put: (call: Call) => {
      const body = call.body as Record<string, unknown>
      user = opts.dropUndeclared ? { ...body, attributes: {} } : body
      return undefined
    },
  }
}

describe('ensureInvitedUser (FLOW-IDN-002, Q9)', () => {
  it('creates the user with UPDATE_PASSWORD + CONFIGURE_TOTP, maps the realm role, sends ONE execute-actions mail and marks it', async () => {
    let createdUser = false
    const u1 = userStore('u-1')
    const { transport, calls } = transportWith({
      [USERS]: () => (createdUser ? [{ id: 'u-1', email: EMAIL }] : []),
      [`POST ${R}/users`]: () => {
        createdUser = true
        return undefined
      },
      [`GET ${R}/roles/it-admin`]: { id: 'r-1', name: 'it-admin' },
      [`GET ${R}/users/profile`]: DEFAULT_PROFILE,
      [`GET ${R}/users/u-1`]: u1.get,
      [`PUT ${R}/users/u-1`]: u1.put,
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
    // the mark is written on the FULL representation (a partial PUT would
    // clear the root attributes on Keycloak 24+) and read back
    const mark = calls.find((c) => c.method === 'PUT' && c.path === `${R}/users/u-1`)!
    expect(mark.body).toMatchObject({ username: EMAIL, email: EMAIL, firstName: 'Ina', attributes: { gremion_invited_at: ['2026-09-30T00:00:00.000Z'] } })
    expect(u1.get()).toMatchObject({ attributes: { gremion_invited_at: ['2026-09-30T00:00:00.000Z'] } })
  })

  // Review B2 MEDIUM (r2): on Keycloak 26 an undeclared (unmanaged) attribute
  // is dropped on write, so the send-once mark never persisted and every rerun
  // re-invited. The realm's user profile now declares it, admin-only.
  it('declares gremion_invited_at admin-only in the realm user profile BEFORE the first mail, keeping every existing attribute', async () => {
    const u1 = userStore('u-1')
    const { transport, calls } = transportWith({
      [USERS]: [{ id: 'u-1', email: EMAIL }],
      [`GET ${R}/roles/it-admin`]: { id: 'r-1', name: 'it-admin' },
      [`GET ${R}/users/profile`]: DEFAULT_PROFILE,
      [`GET ${R}/users/u-1`]: u1.get,
      [`PUT ${R}/users/u-1`]: u1.put,
    })
    await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'it-admin' })
    const iProfile = calls.findIndex((c) => c.method === 'PUT' && c.path === `${R}/users/profile`)
    const iMail = calls.findIndex((c) => c.path.includes('execute-actions-email'))
    expect(iProfile).toBeGreaterThan(-1)
    expect(iProfile).toBeLessThan(iMail)
    const profile = calls[iProfile]!.body as { attributes: Array<Record<string, unknown>>; groups: unknown; unmanagedAttributePolicy?: unknown }
    expect(profile.attributes.map((a) => a.name)).toEqual(['username', 'email', 'firstName', 'lastName', 'gremion_invited_at'])
    expect(profile.attributes.at(-1)).toMatchObject({ name: 'gremion_invited_at', permissions: { view: ['admin'], edit: ['admin'] }, multivalued: false })
    expect(profile.groups).toEqual(DEFAULT_PROFILE.groups)
    // least privilege: no realm-wide unmanaged-attribute policy is switched on
    expect(profile).not.toHaveProperty('unmanagedAttributePolicy')
  })

  it('a realm whose profile already declares the mark gets no profile write', async () => {
    const u1 = userStore('u-1')
    const { transport, calls } = transportWith({
      [USERS]: [{ id: 'u-1', email: EMAIL }],
      [`GET ${R}/roles/it-admin`]: { id: 'r-1', name: 'it-admin' },
      [`GET ${R}/users/profile`]: { ...DEFAULT_PROFILE, attributes: [...DEFAULT_PROFILE.attributes, { name: 'gremion_invited_at' }] },
      [`GET ${R}/users/u-1`]: u1.get,
      [`PUT ${R}/users/u-1`]: u1.put,
    })
    await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'it-admin' })
    expect(calls.some((c) => c.method === 'PUT' && c.path === `${R}/users/profile`)).toBe(false)
    expect(calls.filter((c) => c.path.includes('execute-actions-email'))).toHaveLength(1)
  })

  it('a mark that does not persist is a loud failure (a rerun would otherwise invite again)', async () => {
    const u1 = userStore('u-1', { dropUndeclared: true })
    const { transport } = transportWith({
      [USERS]: [{ id: 'u-1', email: EMAIL }],
      [`GET ${R}/roles/it-admin`]: { id: 'r-1', name: 'it-admin' },
      [`GET ${R}/users/profile`]: { ...DEFAULT_PROFILE, attributes: [...DEFAULT_PROFILE.attributes, { name: 'gremion_invited_at' }] },
      [`GET ${R}/users/u-1`]: u1.get,
      [`PUT ${R}/users/u-1`]: u1.put,
    })
    await expect(new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'it-admin' })).rejects.toThrow(/gremion_invited_at did not persist/)
  })

  it('an unreadable user profile stops BEFORE any mail', async () => {
    const { transport, calls } = transportWith({
      [USERS]: [{ id: 'u-1', email: EMAIL }],
      [`GET ${R}/roles/it-admin`]: { id: 'r-1', name: 'it-admin' },
    })
    await expect(new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'it-admin' })).rejects.toThrow(/user profile/)
    expect(calls.some((c) => c.path.includes('execute-actions-email'))).toBe(false)
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
    const u2 = userStore('u-2')
    const { transport, calls } = transportWith({
      [USERS]: () => (lookups++ === 0 ? [] : [{ id: 'u-2', email: EMAIL }]),
      [`POST ${R}/users`]: () => {
        throw new Error('Keycloak Admin API error: 409 on POST /users: exists')
      },
      [`GET ${R}/roles/council-admin`]: { id: 'r-2', name: 'council-admin' },
      [`GET ${R}/users/profile`]: DEFAULT_PROFILE,
      [`GET ${R}/users/u-2`]: u2.get,
      [`PUT ${R}/users/u-2`]: u2.put,
    })
    const r = await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'council-admin' })
    expect(r).toEqual({ id: 'u-2', created: false, invited: true })
    expect(calls.filter((c) => c.path.includes('execute-actions-email'))).toHaveLength(1)
  })

  // TASK-031 D-5 (operator 2026-10-22): an imported member is asked for a new
  // password ONLY; the TOTP is enrolled at the first step-up. The parameter is
  // additive: every other caller keeps the administrator pair above.
  it('D-5: requiredActions UPDATE_PASSWORD only reaches both the create and the execute-actions mail; names land on create', async () => {
    let createdUser = false
    const u1 = userStore('u-1')
    const { transport, calls } = transportWith({
      [USERS]: () => (createdUser ? [{ id: 'u-1', email: EMAIL }] : []),
      [`POST ${R}/users`]: () => {
        createdUser = true
        return undefined
      },
      [`GET ${R}/roles/member`]: { id: 'r-9', name: 'member' },
      [`GET ${R}/users/profile`]: DEFAULT_PROFILE,
      [`GET ${R}/users/u-1`]: u1.get,
      [`PUT ${R}/users/u-1`]: u1.put,
    })
    const r = await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', {
      email: EMAIL,
      realmRole: 'member',
      requiredActions: ['UPDATE_PASSWORD'],
      firstName: 'Anna Maria',
      lastName: 'Berger',
    })
    expect(r).toEqual({ id: 'u-1', created: true, invited: true })
    const create = calls.find((c) => c.method === 'POST' && c.path === `${R}/users`)!
    expect(create.body).toMatchObject({ requiredActions: ['UPDATE_PASSWORD'], firstName: 'Anna Maria', lastName: 'Berger' })
    expect(calls.find((c) => c.path.startsWith(`${R}/users/u-1/execute-actions-email`))!.body).toEqual(['UPDATE_PASSWORD'])
  })

  it('skipIfHasCredential: an existing user with a credential and no mark is linked, never mailed', async () => {
    const { transport, calls } = transportWith({
      [USERS]: [{ id: 'u-1', email: EMAIL }],
      [`GET ${R}/roles/member`]: { id: 'r-9', name: 'member' },
      [`GET ${R}/users/u-1/credentials`]: [{ id: 'c-1', type: 'password' }],
    })
    const r = await new KcProvisionApi(transport).ensureInvitedUser('musterstadt', { email: EMAIL, realmRole: 'member', skipIfHasCredential: true })
    expect(r).toEqual({ id: 'u-1', created: false, invited: false })
    expect(calls.some((c) => c.path.includes('execute-actions-email'))).toBe(false)
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
