// P2.1c (T10) — KC Admin-API helper unit tests (mocked transport, no network).
import { describe, it, expect } from 'vitest'
import { KcProvisionApi, type KcTransport } from './kc-admin-api'

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
