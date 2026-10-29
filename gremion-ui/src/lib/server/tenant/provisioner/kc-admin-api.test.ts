// P2.1c (T10) — KC Admin-API helper unit tests (mocked transport, no network).
import { describe, it, expect } from 'vitest'
import { KcProvisionApi, REALM_CREATOR_ROLES, type KcTransport } from './kc-admin-api'
import { smtpServerBlock } from './realm-doc'

/** A scriptable transport: maps `${method} ${path}` to a response body. */
function fakeTransport(routes: Record<string, unknown>): {
  transport: KcTransport
  calls: Array<{ method: string; path: string; body?: unknown }>
} {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const transport: KcTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    const key = `${method} ${path}`
    if (key in routes) return routes[key]
    return undefined
  }
  return { transport, calls }
}

describe('KcProvisionApi.createRealm', () => {
  it('POSTs the realm doc to /admin/realms', async () => {
    const { transport, calls } = fakeTransport({})
    const api = new KcProvisionApi(transport)
    await api.createRealm({ realm: 'verein' } as never)
    expect(calls).toContainEqual({ method: 'POST', path: '/admin/realms', body: { realm: 'verein' } })
  })

  it('treats a 409 (realm already exists) as already-present, not an error', async () => {
    const transport: KcTransport = async () => {
      throw new Error('Keycloak Admin API error: 409 conflict')
    }
    const api = new KcProvisionApi(transport)
    await expect(api.createRealm({ realm: 'verein' } as never)).resolves.toEqual({ alreadyExisted: true })
  })
})

describe('KcProvisionApi.createProvisionerServiceAccount (bootstrap §7.2 least-privilege SA)', () => {
  const ROUTES: Record<string, unknown> = {
    'GET /admin/realms/master/clients?clientId=tenant-provisioner': [{ id: 'cli-uuid' }],
    'GET /admin/realms/master/clients/cli-uuid/service-account-user': { id: 'sa-user' },
    'GET /admin/realms/master/roles/create-realm': { id: 'role-cr', name: 'create-realm' },
    'GET /admin/realms/master/clients/cli-uuid/client-secret': { type: 'secret', value: 's3cr3t' },
  }

  it('creates a confidential SA client, assigns the realm-level create-realm role, and returns the secret', async () => {
    const { transport, calls } = fakeTransport(ROUTES)
    const res = await new KcProvisionApi(transport).createProvisionerServiceAccount('master', 'tenant-provisioner', [
      'create-realm',
    ])
    const createCall = calls.find((c) => c.method === 'POST' && c.path === '/admin/realms/master/clients')
    expect(createCall).toBeTruthy()
    expect(createCall!.body).toMatchObject({
      clientId: 'tenant-provisioner',
      serviceAccountsEnabled: true,
      publicClient: false,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
    })
    // realm-LEVEL role mapping (not a realm-management client role) on the SA user
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/admin/realms/master/users/sa-user/role-mappings/realm',
      body: [{ id: 'role-cr', name: 'create-realm' }],
    })
    expect(res).toEqual({ clientSecret: 's3cr3t', created: true })
  })

  it('is idempotent: a 409 on client-create reuses the client (created=false) and still assigns the role + returns the secret', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const transport: KcTransport = async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'POST' && path === '/admin/realms/master/clients') {
        throw new Error('Keycloak Admin API error: 409 conflict')
      }
      return ROUTES[`${method} ${path}`]
    }
    const res = await new KcProvisionApi(transport).createProvisionerServiceAccount('master', 'tenant-provisioner', [
      'create-realm',
    ])
    expect(res).toEqual({ clientSecret: 's3cr3t', created: false })
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/admin/realms/master/users/sa-user/role-mappings/realm',
      body: [{ id: 'role-cr', name: 'create-realm' }],
    })
  })

  it('throws if the SA client is absent after create (serviceAccountsEnabled contract)', async () => {
    const { transport } = fakeTransport({ 'GET /admin/realms/master/clients?clientId=tenant-provisioner': [] })
    await expect(
      new KcProvisionApi(transport).createProvisionerServiceAccount('master', 'tenant-provisioner', ['create-realm']),
    ).rejects.toThrow(/not found/)
  })

  it('throws if KC returns no client secret', async () => {
    const { transport } = fakeTransport({
      ...ROUTES,
      'GET /admin/realms/master/clients/cli-uuid/client-secret': {},
    })
    await expect(
      new KcProvisionApi(transport).createProvisionerServiceAccount('master', 'tenant-provisioner', ['create-realm']),
    ).rejects.toThrow(/secret/)
  })
})

describe('(#48) KcProvisionApi.adoptRealmForProvisioner (bootstrap-provisioner --adopt-realm)', () => {
  // Keycloak 26.6.1 RealmsAdminResource.grantPermissionsToRealmCreator grants the
  // creator AdminRoles.ALL_REALM_ROLES on the master "<realm>-realm" client.
  const KC_26_6_1_ALL_REALM_ROLES = [
    'create-client', 'view-realm', 'view-users', 'view-clients', 'view-events', 'view-identity-providers', 'view-authorization',
    'manage-realm', 'manage-users', 'manage-clients', 'manage-events', 'manage-identity-providers', 'manage-authorization',
    'query-users', 'query-clients', 'query-realms', 'query-groups',
  ]
  const M = '/admin/realms/master'
  const routes = (held: string[]): Record<string, unknown> => {
    const r: Record<string, unknown> = {
      [`GET ${M}/clients?clientId=tenant-provisioner`]: [{ id: 'cli-uuid', clientId: 'tenant-provisioner' }],
      [`GET ${M}/clients/cli-uuid/service-account-user`]: { id: 'sa-user' },
      [`GET ${M}/clients?clientId=imported-realm`]: [{ id: 'mgmt-uuid', clientId: 'imported-realm' }],
      [`GET ${M}/users/sa-user/role-mappings/clients/mgmt-uuid`]: held.map((name) => ({ id: `r-${name}`, name })),
    }
    // the management client also carries roles a creator is NOT given
    for (const name of [...KC_26_6_1_ALL_REALM_ROLES, 'impersonation', 'view-system']) r[`GET ${M}/clients/mgmt-uuid/roles/${name}`] = { id: `r-${name}`, name }
    return r
  }
  const grants = (calls: Array<{ method: string; path: string; body?: unknown }>) =>
    calls.filter((c) => c.method !== 'GET')
  // Keycloak's mapping endpoint: a POST adds to what the next GET returns (unless `dropOnPost`).
  const fakeTransport = (r: Record<string, unknown>, dropOnPost = false) => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const mapping = `${M}/users/sa-user/role-mappings/clients/mgmt-uuid`
    const transport: KcTransport = async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'POST' && path === mapping && !dropOnPost) r[`GET ${mapping}`] = [...((r[`GET ${mapping}`] as unknown[]) ?? []), ...(body as unknown[])]
      return r[`${method} ${path}`]
    }
    return { transport, calls }
  }

  it('fails loudly when the read-back after the grant still lacks a role', async () => {
    const { transport } = fakeTransport(routes([]), true)
    await expect(new KcProvisionApi(transport).adoptRealmForProvisioner('tenant-provisioner', 'imported')).rejects.toThrow(/still lacks/)
  })

  it('REALM_CREATOR_ROLES is exactly the set Keycloak grants a realm creator (no impersonation, no view-system, no admin)', () => {
    expect([...REALM_CREATOR_ROLES].sort()).toEqual([...KC_26_6_1_ALL_REALM_ROLES].sort())
  })

  it('grants exactly the creator roles on master "<realm>-realm" to the SA user, in one POST', async () => {
    const { transport, calls } = fakeTransport(routes([]))
    const res = await new KcProvisionApi(transport).adoptRealmForProvisioner('tenant-provisioner', 'imported')
    const writes = grants(calls)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.method).toBe('POST')
    expect(writes[0]!.path).toBe(`${M}/users/sa-user/role-mappings/clients/mgmt-uuid`)
    const names = (writes[0]!.body as Array<{ name: string }>).map((r) => r.name).sort()
    expect(names).toEqual([...KC_26_6_1_ALL_REALM_ROLES].sort())
    expect(res).toEqual({ granted: [...REALM_CREATOR_ROLES], alreadyHeld: [] })
    // every call stays in the master realm: nothing is read or written in the adopted realm itself
    expect(calls.every((c) => c.path.startsWith(`${M}/`))).toBe(true)
  })

  it('is idempotent: a second run on a fully adopted realm writes nothing', async () => {
    const { transport, calls } = fakeTransport(routes([...KC_26_6_1_ALL_REALM_ROLES]))
    const res = await new KcProvisionApi(transport).adoptRealmForProvisioner('tenant-provisioner', 'imported')
    expect(grants(calls)).toEqual([])
    expect(res.granted).toEqual([])
    expect([...res.alreadyHeld].sort()).toEqual([...KC_26_6_1_ALL_REALM_ROLES].sort())
  })

  it('a partial earlier grant: only the missing roles are posted', async () => {
    const { transport, calls } = fakeTransport(routes(['view-realm', 'manage-realm']))
    const res = await new KcProvisionApi(transport).adoptRealmForProvisioner('tenant-provisioner', 'imported')
    const posted = (grants(calls)[0]!.body as Array<{ name: string }>).map((r) => r.name)
    expect(posted).not.toContain('view-realm')
    expect(posted).not.toContain('manage-realm')
    expect(posted).toHaveLength(KC_26_6_1_ALL_REALM_ROLES.length - 2)
    expect(res.alreadyHeld).toEqual(['view-realm', 'manage-realm'])
  })

  it('refuses the master realm (its "master-realm" client is the whole Keycloak) before any call', async () => {
    const { transport, calls } = fakeTransport(routes([]))
    await expect(new KcProvisionApi(transport).adoptRealmForProvisioner('tenant-provisioner', 'master')).rejects.toThrow(/master/)
    expect(calls).toEqual([])
  })

  it('refuses a realm name that is not a plain realm name, before any call', async () => {
    const { transport, calls } = fakeTransport(routes([]))
    for (const bad of ['', 'a/b', '../x', 'x&clientId=y', 'Imported ', '-x']) {
      await expect(new KcProvisionApi(transport).adoptRealmForProvisioner('tenant-provisioner', bad)).rejects.toThrow(/realm name/)
    }
    expect(calls).toEqual([])
  })

  it('names the fix when the SA is absent (bootstrap-provisioner first) or the realm has no master management client', async () => {
    const noSa = fakeTransport({ ...routes([]), [`GET ${M}/clients?clientId=tenant-provisioner`]: [] })
    await expect(new KcProvisionApi(noSa.transport).adoptRealmForProvisioner('tenant-provisioner', 'imported')).rejects.toThrow(/bootstrap-provisioner/)
    expect(grants(noSa.calls)).toEqual([])
    const noRealm = fakeTransport({ ...routes([]), [`GET ${M}/clients?clientId=imported-realm`]: [] })
    await expect(new KcProvisionApi(noRealm.transport).adoptRealmForProvisioner('tenant-provisioner', 'imported')).rejects.toThrow(/imported-realm/)
    expect(grants(noRealm.calls)).toEqual([])
  })

  it('ignores a search hit whose clientId is not an exact match (Keycloak clientId search is not exact)', async () => {
    const { transport, calls } = fakeTransport({
      ...routes([]),
      [`GET ${M}/clients?clientId=imported-realm`]: [{ id: 'other', clientId: 'imported-realm-x' }],
    })
    await expect(new KcProvisionApi(transport).adoptRealmForProvisioner('tenant-provisioner', 'imported')).rejects.toThrow(/imported-realm/)
    expect(grants(calls)).toEqual([])
  })
})

describe('KcProvisionApi.realmExists', () => {
  it('true when GET /admin/realms/<realm> succeeds', async () => {
    const { transport } = fakeTransport({ 'GET /admin/realms/verein': { realm: 'verein' } })
    expect(await new KcProvisionApi(transport).realmExists('verein')).toBe(true)
  })
  it('false when GET 404s', async () => {
    const transport: KcTransport = async () => {
      throw new Error('Keycloak Admin API error: 404 not found')
    }
    expect(await new KcProvisionApi(transport).realmExists('verein')).toBe(false)
  })
  it('false when GET 403s (least-priv create-realm SA cannot view a not-yet-existing realm — KC returns 403, not 404)', async () => {
    // The §7.2 `tenant-provisioner` SA holds ONLY `create-realm`; KC returns 403
    // (not 404) when it GETs a realm it has no realm-management role on, which for
    // a fresh tenant is the realm being provisioned. Treat that as "absent" — if
    // the realm DID exist, createRealm's 409 path is the authoritative backstop.
    const transport: KcTransport = async () => {
      throw new Error('Keycloak Admin API error: 403 on GET /admin/realms/verein: Forbidden')
    }
    expect(await new KcProvisionApi(transport).realmExists('verein')).toBe(false)
  })
  it('still rethrows a non-403/404 error (e.g. 500)', async () => {
    const transport: KcTransport = async () => {
      throw new Error('Keycloak Admin API error: 500 boom')
    }
    await expect(new KcProvisionApi(transport).realmExists('verein')).rejects.toThrow(/500/)
  })
})

describe('KcProvisionApi.deleteRealm (T17 — idempotent realm teardown)', () => {
  it('DELETEs /admin/realms/<realm>', async () => {
    const { transport, calls } = fakeTransport({})
    await new KcProvisionApi(transport).deleteRealm('verein')
    expect(calls).toContainEqual({ method: 'DELETE', path: '/admin/realms/verein', body: undefined })
  })

  it('tolerates a 404 (realm already gone) as a no-op, not an error', async () => {
    const transport: KcTransport = async () => {
      throw new Error('Keycloak Admin API error: 404 not found')
    }
    await expect(new KcProvisionApi(transport).deleteRealm('verein')).resolves.toBeUndefined()
  })

  it('rethrows a non-404 error (e.g. 500)', async () => {
    const transport: KcTransport = async () => {
      throw new Error('Keycloak Admin API error: 500 boom')
    }
    await expect(new KcProvisionApi(transport).deleteRealm('verein')).rejects.toThrow(/500/)
  })
})

describe('KcProvisionApi realm-segment encoding (C — defence-in-depth)', () => {
  it('encodeURIComponents the realm in deleteRealm so it cannot break out of its path segment', async () => {
    const { transport, calls } = fakeTransport({})
    // A realm containing path-traversal + query chars (the CLI guard would
    // already reject this, but the transport must still encode defensively).
    await new KcProvisionApi(transport).deleteRealm('../master?evil=1')
    expect(calls).toContainEqual({
      method: 'DELETE',
      path: '/admin/realms/..%2Fmaster%3Fevil%3D1',
      body: undefined,
    })
  })

  it('encodeURIComponents the realm in realmExists (GET path)', async () => {
    const { transport, calls } = fakeTransport({})
    await new KcProvisionApi(transport).realmExists('a b/c')
    expect(calls).toContainEqual({ method: 'GET', path: '/admin/realms/a%20b%2Fc', body: undefined })
  })

  it('leaves a slug-shaped realm untouched (encodeURIComponent is a no-op for [a-z0-9-])', async () => {
    const { transport, calls } = fakeTransport({})
    await new KcProvisionApi(transport).deleteRealm('verein')
    expect(calls).toContainEqual({ method: 'DELETE', path: '/admin/realms/verein', body: undefined })
  })
})

describe('KcProvisionApi.assignServiceAccountRealmRoles (A — ported assign_realm_admin_to_sa)', () => {
  function routes() {
    return {
      'GET /admin/realms/verein/clients?clientId=gremion-admin': [{ id: 'uuid-admin' }],
      'GET /admin/realms/verein/clients/uuid-admin/service-account-user': { id: 'sa-user-1' },
      'GET /admin/realms/verein/clients?clientId=realm-management': [{ id: 'uuid-rm' }],
      'GET /admin/realms/verein/clients/uuid-rm/roles/realm-admin': { id: 'role-1', name: 'realm-admin' },
    }
  }

  it('resolves client -> SA-user -> realm-management role and POSTs the role-mapping', async () => {
    const { transport, calls } = fakeTransport(routes())
    await new KcProvisionApi(transport).assignServiceAccountRealmRoles('verein', 'gremion-admin', ['realm-admin'])
    const post = calls.find(
      (c) => c.method === 'POST' && c.path === '/admin/realms/verein/users/sa-user-1/role-mappings/clients/uuid-rm',
    )
    expect(post).toBeDefined()
    // the body is the array of resolved realm-management role reps
    expect(post!.body).toEqual([{ id: 'role-1', name: 'realm-admin' }])
  })

  it('throws (loud) when the client is absent', async () => {
    const { transport } = fakeTransport({ 'GET /admin/realms/verein/clients?clientId=gremion-admin': [] })
    await expect(
      new KcProvisionApi(transport).assignServiceAccountRealmRoles('verein', 'gremion-admin', ['realm-admin']),
    ).rejects.toThrow(/client "gremion-admin" not found/)
  })

  it('throws (loud) when the service-account user is absent (serviceAccountsEnabled unset)', async () => {
    const r = routes()
    ;(r as Record<string, unknown>)['GET /admin/realms/verein/clients/uuid-admin/service-account-user'] = {}
    const { transport } = fakeTransport(r)
    await expect(
      new KcProvisionApi(transport).assignServiceAccountRealmRoles('verein', 'gremion-admin', ['realm-admin']),
    ).rejects.toThrow(/no service-account user/)
  })

  it('no-ops (no POST) when the role list is empty', async () => {
    const { transport, calls } = fakeTransport(routes())
    await new KcProvisionApi(transport).assignServiceAccountRealmRoles('verein', 'gremion-admin', [])
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })
})

describe('KcProvisionApi.getServiceAccountRealmRoleNames (A — reconcile reader)', () => {
  it('returns the realm-management role names mapped to the SA user', async () => {
    const { transport } = fakeTransport({
      'GET /admin/realms/verein/clients?clientId=gremion-admin': [{ id: 'uuid-admin' }],
      'GET /admin/realms/verein/clients/uuid-admin/service-account-user': { id: 'sa-user-1' },
      'GET /admin/realms/verein/clients?clientId=realm-management': [{ id: 'uuid-rm' }],
      'GET /admin/realms/verein/users/sa-user-1/role-mappings/clients/uuid-rm': [
        { name: 'realm-admin' },
        { name: 'view-realm' },
      ],
    })
    expect(await new KcProvisionApi(transport).getServiceAccountRealmRoleNames('verein', 'gremion-admin')).toEqual([
      'realm-admin',
      'view-realm',
    ])
  })

  it('returns [] when the client is absent (no throw — the upstream check fails loudly)', async () => {
    const { transport } = fakeTransport({ 'GET /admin/realms/verein/clients?clientId=gremion-admin': [] })
    expect(await new KcProvisionApi(transport).getServiceAccountRealmRoleNames('verein', 'gremion-admin')).toEqual([])
  })
})

describe('KcProvisionApi.configureStepupFlow (ported §4-2, idempotent)', () => {
  it('skips the (non-idempotent) flow build when browser-stepup already exists', async () => {
    const { transport, calls } = fakeTransport({
      'GET /admin/realms/verein/authentication/flows': [{ alias: 'browser-stepup' }],
      'GET /admin/realms/verein': { realm: 'verein', attributes: {} },
      'GET /admin/realms/verein/clients?clientId=gremion-ui': [{ id: 'uuid-ui' }],
      'GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models': [
        { protocolMapper: 'oidc-acr-mapper' },
      ],
    })
    const api = new KcProvisionApi(transport)
    await api.configureStepupFlow('verein')
    // No flow-copy POST (build skipped)
    expect(calls.some((c) => c.path.includes('/flows/browser/copy'))).toBe(false)
    // Realm PUT still ran (ORDER: flow before browserFlow PUT) merging acr.loa.map
    const realmPut = calls.find((c) => c.method === 'PUT' && c.path === '/admin/realms/verein')
    expect(realmPut).toBeDefined()
    expect((realmPut!.body as any).browserFlow).toBe('browser-stepup')
    expect((realmPut!.body as any).attributes['acr.loa.map']).toBe('{"loa1":1,"loa2":2}')
    // acr mapper already present -> no POST
    expect(calls.some((c) => c.path.endsWith('/protocol-mappers/models') && c.method === 'POST')).toBe(false)
  })

  it('builds browser-stepup (copy + subflows) when absent and adds the acr mapper', async () => {
    const { transport, calls } = fakeTransport({
      'GET /admin/realms/verein/authentication/flows': [], // absent -> build
      'GET /admin/realms/verein': { realm: 'verein', attributes: {} },
      'GET /admin/realms/verein/clients?clientId=gremion-ui': [{ id: 'uuid-ui' }],
      'GET /admin/realms/verein/clients/uuid-ui/protocol-mappers/models': [], // mapper absent
      'GET /admin/realms/verein/authentication/flows/browser-stepup/executions': [],
      'GET /admin/realms/verein/authentication/flows/stepup-1fa/executions': [],
      'GET /admin/realms/verein/authentication/flows/stepup-2fa/executions': [],
    })
    const api = new KcProvisionApi(transport)
    await api.configureStepupFlow('verein')
    // The flow was copied from browser (build path taken)
    expect(calls.some((c) => c.method === 'POST' && c.path.includes('/flows/browser/copy'))).toBe(true)
    // acr mapper POSTed to the gremion-ui client
    expect(
      calls.some(
        (c) => c.method === 'POST' && c.path === '/admin/realms/verein/clients/uuid-ui/protocol-mappers/models',
      ),
    ).toBe(true)
  })
})

describe('KcProvisionApi.configureStepupFlow: a fresh build is never live in the enrol-then-loa2 shape', () => {
  it('converts the REQUIRED OTP form to OTP-or-deny BEFORE the realm is pointed at browser-stepup (a crash in between must not serve it)', async () => {
    const F = '/admin/realms/verein/authentication'
    const SUB = 'stepup-2fa%20second%20factor'
    let created = false
    let adds = 0
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const legacy = [
      { id: 'c2', providerId: 'conditional-level-of-authentication', requirement: 'REQUIRED', level: 0, index: 0 },
      { id: 'o2', providerId: 'auth-otp-form', requirement: 'REQUIRED', level: 0, index: 1 },
    ]
    const transport: KcTransport = async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'POST' && path === `${F}/flows/stepup-2fa/executions/flow`) created = true
      if (method === 'POST' && path === `${F}/flows/${SUB}/executions/execution`) adds++
      if (method === 'GET' && path === `${F}/flows`) return []
      if (method === 'GET' && path === '/admin/realms/verein') return { realm: 'verein', attributes: {} }
      if (method === 'GET' && path === `${F}/flows/stepup-2fa/executions`) {
        return created
          ? [...legacy, { id: 's2', displayName: 'stepup-2fa second factor', authenticationFlow: true, requirement: 'DISABLED', level: 0, index: 2 }]
          : legacy
      }
      if (method === 'GET' && path === `${F}/flows/${SUB}/executions`) {
        return [
          ...(adds >= 1 ? [{ id: 'n1', providerId: 'auth-otp-form', requirement: 'DISABLED', level: 0, index: 0 }] : []),
          ...(adds >= 2 ? [{ id: 'n2', providerId: 'deny-access-authenticator', requirement: 'DISABLED', level: 0, index: 1 }] : []),
        ]
      }
      if (method === 'GET') return []
      return undefined
    }
    await new KcProvisionApi(transport).configureStepupFlow('verein')
    const bindAt = calls.findIndex((c) => c.method === 'PUT' && c.path === '/admin/realms/verein' && (c.body as { browserFlow?: string }).browserFlow === 'browser-stepup')
    const legacyGoneAt = calls.findIndex((c) => c.method === 'DELETE' && c.path === `${F}/executions/o2`)
    expect(bindAt).toBeGreaterThan(-1)
    expect(legacyGoneAt).toBeGreaterThan(-1)
    expect(legacyGoneAt).toBeLessThan(bindAt)
  })
})

describe('updateRealmSmtp — the gremion#6 delta for an ALREADY-CREATED realm (never a re-import)', () => {
  it('PUTs the realm rep with only realm + smtpServer, on the realm-scoped path', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const api = new KcProvisionApi(async (method, path, body) => {
      calls.push({ method, path, body })
      return undefined
    })
    const block = smtpServerBlock({
      host: 'mail.example.org', port: 587, from: 'no-reply@example.org',
      user: 'platform@example.org', password: 'pw',
    })
    await api.updateRealmSmtp('verein', block)
    expect(calls).toEqual([
      { method: 'PUT', path: '/admin/realms/verein', body: { realm: 'verein', smtpServer: block } },
    ])
  })

  it('encodes the realm segment like every other realm-scoped call', async () => {
    const calls: string[] = []
    const api = new KcProvisionApi(async (_m, path) => { calls.push(path); return undefined })
    await api.updateRealmSmtp('a b', { host: 'mail.example.org' })
    expect(calls[0]).toBe('/admin/realms/a%20b')
  })
})

// Security sweep 2, finding 3: stepup-2fa must be OTP-or-deny, never a REQUIRED
// OTP form (Keycloak would enroll an authenticator inside the step-up, then
// grant loa2 to whoever holds the session or the password).
describe('KcProvisionApi.ensureStepup2faSecondFactor', () => {
  const F = '/admin/realms/verein/authentication'
  const SUB = 'stepup-2fa%20second%20factor'
  const legacy = [
    { id: 'c2', providerId: 'conditional-level-of-authentication', requirement: 'REQUIRED', level: 0, index: 0 },
    { id: 'o2', providerId: 'auth-otp-form', requirement: 'REQUIRED', level: 0, index: 1 },
  ]
  const green = [
    { id: 'c2', providerId: 'conditional-level-of-authentication', requirement: 'REQUIRED', level: 0, index: 0 },
    { id: 's2', displayName: 'stepup-2fa second factor', authenticationFlow: true, requirement: 'REQUIRED', level: 0, index: 1 },
    { id: 'o2', providerId: 'auth-otp-form', requirement: 'ALTERNATIVE', level: 1, index: 0 },
    { id: 'd2', providerId: 'deny-access-authenticator', requirement: 'ALTERNATIVE', level: 1, index: 1 },
  ]

  it('is a no-op (reads only) on an already hardened flow', async () => {
    const { transport, calls } = fakeTransport({ [`GET ${F}/flows/stepup-2fa/executions`]: green })
    await new KcProvisionApi(transport).ensureStepup2faSecondFactor('verein')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('does nothing when stepup-2fa has no OTP form at all (structural drift is the rebuild path)', async () => {
    const { transport, calls } = fakeTransport({ [`GET ${F}/flows/stepup-2fa/executions`]: [] })
    await new KcProvisionApi(transport).ensureStepup2faSecondFactor('verein')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('converts the legacy REQUIRED OTP form, deleting it only AFTER the replacement is wired (a crash never leaves a flow with no second factor)', async () => {
    let created = false
    let adds = 0
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    const transport: KcTransport = async (method, path, body) => {
      calls.push({ method, path, body })
      if (method === 'POST' && path === `${F}/flows/stepup-2fa/executions/flow`) created = true
      if (method === 'POST' && path === `${F}/flows/${SUB}/executions/execution`) adds++
      if (method === 'GET' && path === `${F}/flows/stepup-2fa/executions`) {
        return created
          ? [...legacy, { id: 's2', displayName: 'stepup-2fa second factor', authenticationFlow: true, requirement: 'DISABLED', level: 0, index: 2 }]
          : legacy
      }
      if (method === 'GET' && path === `${F}/flows/${SUB}/executions`) {
        return [
          ...(adds >= 1 ? [{ id: 'n1', providerId: 'auth-otp-form', requirement: 'DISABLED', level: 0, index: 0 }] : []),
          ...(adds >= 2 ? [{ id: 'n2', providerId: 'deny-access-authenticator', requirement: 'DISABLED', level: 0, index: 1 }] : []),
        ]
      }
      return undefined
    }
    await new KcProvisionApi(transport).ensureStepup2faSecondFactor('verein')
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace(F, '')} ${JSON.stringify(c.body ?? null)}`)
    expect(writes).toEqual([
      'POST /flows/stepup-2fa/executions/flow {"alias":"stepup-2fa second factor","type":"basic-flow"}',
      `POST /flows/${SUB}/executions/execution {"provider":"auth-otp-form"}`,
      `POST /flows/${SUB}/executions/execution {"provider":"deny-access-authenticator"}`,
      'PUT /flows/browser-stepup/executions {"id":"s2","requirement":"REQUIRED"}',
      'PUT /flows/browser-stepup/executions {"id":"n1","requirement":"ALTERNATIVE"}',
      'PUT /flows/browser-stepup/executions {"id":"n2","requirement":"ALTERNATIVE"}',
      'DELETE /executions/o2 null',
    ])
  })

  it('resumes a run that died after creating the subflow (no second subflow, no duplicate children)', async () => {
    const half = [
      ...legacy,
      { id: 's2', displayName: 'stepup-2fa second factor', authenticationFlow: true, requirement: 'DISABLED', level: 0, index: 2 },
    ]
    const { transport, calls } = fakeTransport({
      [`GET ${F}/flows/stepup-2fa/executions`]: half,
      [`GET ${F}/flows/${SUB}/executions`]: [
        { id: 'n1', providerId: 'auth-otp-form', requirement: 'ALTERNATIVE', level: 0, index: 0 },
        { id: 'n2', providerId: 'deny-access-authenticator', requirement: 'DISABLED', level: 0, index: 1 },
      ],
    })
    await new KcProvisionApi(transport).ensureStepup2faSecondFactor('verein')
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { id: 's2', requirement: 'REQUIRED' },
      { id: 'n2', requirement: 'ALTERNATIVE' },
    ])
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`${F}/executions/o2`])
  })

  it('configureStepupFlow runs it on an EXISTING flow (the repair path of every live realm)', async () => {
    const { transport, calls } = fakeTransport({
      'GET /admin/realms/verein/authentication/flows': [{ alias: 'browser-stepup' }],
      'GET /admin/realms/verein': { realm: 'verein', attributes: {} },
      'GET /admin/realms/verein/clients?clientId=gremion-ui': [],
      [`GET ${F}/flows/stepup-2fa/executions`]: green,
    })
    await new KcProvisionApi(transport).configureStepupFlow('verein')
    expect(calls.some((c) => c.method === 'GET' && c.path === `${F}/flows/stepup-2fa/executions`)).toBe(true)
  })
})
