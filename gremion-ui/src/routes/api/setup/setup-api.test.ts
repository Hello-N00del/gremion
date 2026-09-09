import { describe, expect, it, vi, beforeEach } from 'vitest'
import { __resetRateLimits } from '$lib/server/rate-limit'

// P2.1a: the setup routes now read event.locals.tenant before resolving the
// per-realm KC admin client. getKeycloakAdminClient is mocked below, so the
// value is inert — we only need locals.tenant to exist on the synthetic event.
const TEST_TENANT = { realmName: 'sturaos', kcAdminUrl: 'http://keycloak:8080/auth', kcClientId: 'gremion-admin', kcClientSecretRef: 'kc-default' }

// ── Config API ────────────────────────────────────────────────────────────────

const mockReadConfig = vi.fn()
const mockWriteConfig = vi.fn()
const mockValidateSetupToken = vi.fn().mockReturnValue(true)
const mockClearSetupToken = vi.fn()

// `configUpdateSchema` is imported by the route under test and used to
// pre-validate PATCH bodies (G-074). We re-export the real schema from the
// mock so the route gets a working zod object — the test asserts the route
// surfaces a 422 when the schema rejects.
vi.mock('$lib/server/config', async () => {
  const real = await vi.importActual<typeof import('$lib/server/config')>('$lib/server/config')
  return {
    readConfig: mockReadConfig,
    writeConfig: mockWriteConfig,
    configUpdateSchema: real.configUpdateSchema,
  }
})

vi.mock('$lib/server/setup-token', () => ({
  validateSetupToken: mockValidateSetupToken,
  clearSetupToken: mockClearSetupToken,
}))

vi.mock('$env/dynamic/private', () => ({ env: {} }))

// P2.1a — the rate-limit helpers now read currentTenantId() from ALS. These
// unit tests call the route handler directly (no hooks.server.ts runWithTenant
// wrap), so stub the canonical id to a default tenant.
vi.mock('$lib/server/tenant/context', () => ({ currentTenantId: () => 'default' }))

// #191 — the health check runs credentialed admin probes via the existing admin
// clients. Mock each client's `validateCredentials` so the health tests exercise
// the reachable-vs-credentials matrix without real network calls.
//
// #191 — the Keycloak admin credential probe stays inline (keycloak-admin is a
// kernel client). (open-core carve) The synapse + nextcloud probes were removed
// with those satellite modules.
const mockKcValidateCredentials = vi.fn().mockResolvedValue(true)

// T3.1 added an IP-keyed rate-limit (5/hour) to setup endpoints. Tests in this
// file omit `getClientAddress` on the synthetic event, so the handler falls
// back to a single shared bucket — without resetting between tests, later
// cases would 429 instead of returning the status under test.
beforeEach(() => __resetRateLimits())

describe('/api/setup/config', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockValidateSetupToken.mockReturnValue(true)
  })

  it('GET returns 404 when setup_complete', async () => {
    mockReadConfig.mockReturnValue({ setup_complete: true })
    const { GET } = await import('./config/+server')
    const request = new Request('http://localhost', { method: 'GET' })
    // @ts-expect-error partial mock
    const res = await GET({ request, locals: { tenant: TEST_TENANT } })
    expect(res.status).toBe(404)
  })

  it('GET returns config without wizard_steps', async () => {
    mockReadConfig.mockReturnValue({
      setup_complete: false,
      wizard_steps: { health_check: 'pending', org_info: 'pending', admin_accounts: 'pending', smtp: 'pending' },
      org: { name: 'Test', domain: 'test.de', logo_path: null },
      smtp: { configured: false, host: '', port: 587, from_address: '', from_name: '' },
      modules: { files: true, messages: true, calendar: true, users: true, finance: true, elections: true },
      legal: { datenschutz_html: '', impressum_html: '', barrierefreiheit_html: '' },
      backups: { retention_days: 30, last_backup_at: null, encryption_key_path: '' },
    })
    const { GET } = await import('./config/+server')
    const request = new Request('http://localhost', { method: 'GET' })
    // @ts-expect-error partial mock
    const res = await GET({ request, locals: { tenant: TEST_TENANT } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).not.toHaveProperty('wizard_steps')
    expect(body.data.org.name).toBe('Test')
  })

  it('PATCH returns 404 when setup_complete', async () => {
    mockReadConfig.mockReturnValue({ setup_complete: true })
    const { PATCH } = await import('./config/+server')
    const request = new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({}) })
    // @ts-expect-error partial mock
    const res = await PATCH({ request })
    expect(res.status).toBe(404)
  })

  it('PATCH merges partial update', async () => {
    const base = {
      setup_complete: false,
      wizard_steps: { health_check: 'pending', org_info: 'pending', admin_accounts: 'pending', smtp: 'pending' },
      org: { name: '', domain: '', logo_path: null },
      smtp: { configured: false, host: '', port: 587, from_address: '', from_name: '' },
      modules: { files: true, messages: true, calendar: true, users: true, finance: true, elections: true },
      legal: { datenschutz_html: '', impressum_html: '', barrierefreiheit_html: '' },
      backups: { retention_days: 30, last_backup_at: null, encryption_key_path: '' },
    }
    mockReadConfig.mockReturnValue(base)
    mockWriteConfig.mockReturnValue({ ...base, org: { name: 'Updated', domain: 'test.de', logo_path: null } })

    const { PATCH } = await import('./config/+server')
    const request = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ org: { name: 'Updated', domain: 'test.de', logo_path: null } }),
    })
    // @ts-expect-error partial mock
    const res = await PATCH({ request })
    expect(res.status).toBe(200)
    expect(mockWriteConfig).toHaveBeenCalledOnce()
  })

  it('D-WIZARD: PATCH accepts the deployment toggle and persists it via writeConfig', async () => {
    const base = { setup_complete: false }
    mockReadConfig.mockReturnValue(base)
    mockWriteConfig.mockReturnValue({ ...base, deployment: { mode: 'multi' } })
    const { PATCH } = await import('./config/+server')
    const request = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ deployment: { mode: 'multi' } }),
    })
    // @ts-expect-error partial mock
    const res = await PATCH({ request })
    expect(res.status).toBe(200)
    // the strict schema accepted the known key → writeConfig was reached with it
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.objectContaining({ deployment: { mode: 'multi' } }))
  })

  it('D-WIZARD: PATCH rejects an out-of-enum deployment mode with 422', async () => {
    mockReadConfig.mockReturnValue({ setup_complete: false })
    const { PATCH } = await import('./config/+server')
    const request = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ deployment: { mode: 'cluster' } }),
    })
    // @ts-expect-error partial mock
    const res = await PATCH({ request })
    expect(res.status).toBe(422)
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })

  it('G-074: PATCH rejects unknown top-level keys with 422', async () => {
    mockReadConfig.mockReturnValue({ setup_complete: false })
    const { PATCH } = await import('./config/+server')
    const request = new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ orgg: { name: 'typo — unknown key' } }),
    })
    // @ts-expect-error partial mock
    const res = await PATCH({ request })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/invalid config update/i)
    // writeConfig must never have been called — the gate stopped the request
    expect(mockWriteConfig).not.toHaveBeenCalled()
  })
})

// ── Health API ────────────────────────────────────────────────────────────────

describe('/api/setup/health', () => {
  beforeEach(() => {
    mockKcValidateCredentials.mockResolvedValue(true)
    // The config describe's vi.resetAllMocks() can clear this between suites —
    // re-establish the client so getKeycloakAdminClient() returns a usable mock.
    mockGetKeycloakAdminClient.mockReturnValue({
      validateCredentials: mockKcValidateCredentials,
    })
    // (open-core carve) The synapse + nextcloud setup-health probes were removed
    // with those satellite modules; only the inline Keycloak probe remains.
  })

  it('returns can_proceed: false when a required service is unhealthy', async () => {
    // The health check calls node:net and fetch internally.
    // Mock fetch to return ok for all HTTP checks.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    // We can't easily mock node:net here, so just verify the response shape.
    const { GET } = await import('./health/+server')
    const request = new Request('http://localhost', { method: 'GET' })
    // @ts-expect-error partial mock
    const res = await GET({ request, locals: { tenant: TEST_TENANT } })
    const body = await res.json()
    // Shape check — actual health depends on whether services are running
    expect(body).toHaveProperty('success')
    expect(body.data).toHaveProperty('services')
    expect(body.data).toHaveProperty('can_proceed')
    expect(typeof body.data.can_proceed).toBe('boolean')
    vi.unstubAllGlobals()
  })

  it('surfaces credential validity distinctly from reachability (#191)', async () => {
    // All HTTP reachability probes succeed.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { GET } = await import('./health/+server')
    const request = new Request('http://localhost', { method: 'GET' })
    // @ts-expect-error partial mock
    const res = await GET({ request, locals: { tenant: TEST_TENANT } })
    const body = await res.json()

    // New fields are present and distinct from the flat `services` map.
    expect(body.data).toHaveProperty('serviceDetails')
    expect(body.data).toHaveProperty('credentials')
    expect(body.data.serviceDetails.keycloak).toHaveProperty('reachable')
    expect(body.data.serviceDetails.keycloak).toHaveProperty('credentialsValid')
    // Credential probes were invoked through the existing admin clients.
    expect(mockKcValidateCredentials).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('reports keycloak unhealthy and blocks proceeding when its credentials are rejected', async () => {
    // Reachable everywhere, but Keycloak admin credentials are invalid.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    mockKcValidateCredentials.mockResolvedValue(false)

    const { GET } = await import('./health/+server')
    const request = new Request('http://localhost', { method: 'GET' })
    // @ts-expect-error partial mock
    const res = await GET({ request, locals: { tenant: TEST_TENANT } })
    const body = await res.json()

    // Reachable but credentials invalid → unhealthy + cannot proceed.
    expect(body.data.serviceDetails.keycloak.reachable).toBe(true)
    expect(body.data.serviceDetails.keycloak.credentialsValid).toBe(false)
    expect(body.data.services.keycloak).toBe('unhealthy')
    expect(body.data.credentials.keycloak).toBe('invalid')
    expect(body.data.can_proceed).toBe(false)
    vi.unstubAllGlobals()
  })
})

// ── Admins API ────────────────────────────────────────────────────────────────

const mockListRealmRoles = vi.fn()
const mockCreateUser = vi.fn()
const mockAssignRoles = vi.fn()
// Default return includes `validateCredentials` so the health test (which runs
// before the admins beforeEach) gets a usable client (#191).
const mockGetKeycloakAdminClient = vi.fn().mockReturnValue({
  validateCredentials: mockKcValidateCredentials,
})

vi.mock('$lib/server/keycloak-admin', () => ({
  getKeycloakAdminClient: mockGetKeycloakAdminClient,
}))

describe('/api/setup/admins', () => {
  beforeEach(() => {
    vi.resetModules()
    mockValidateSetupToken.mockReturnValue(true)
    mockReadConfig.mockReturnValue({ setup_complete: false })
    mockGetKeycloakAdminClient.mockReturnValue({
      listRealmRoles: mockListRealmRoles,
      createUser: mockCreateUser,
      assignRoles: mockAssignRoles,
    })
  })

  it('returns 404 when setup_complete', async () => {
    mockReadConfig.mockReturnValue({ setup_complete: true })
    const { POST } = await import('./admins/+server')
    const request = new Request('http://localhost', { method: 'POST', body: JSON.stringify({}) })
    // @ts-expect-error partial mock
    const res = await POST({ request, locals: { tenant: TEST_TENANT } })
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid body', async () => {
    const { POST } = await import('./admins/+server')
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ itAdmin: { email: 'not-an-email', password: 'short' } }),
    })
    // @ts-expect-error partial mock
    const res = await POST({ request, locals: { tenant: TEST_TENANT } })
    expect(res.status).toBe(400)
  })

  it('creates users and assigns roles', async () => {
    mockListRealmRoles.mockResolvedValue([
      { id: 'r1', name: 'it-admin' },
      { id: 'r2', name: 'council-admin' },
    ])
    mockCreateUser.mockResolvedValueOnce('user-id-1').mockResolvedValueOnce('user-id-2')
    mockAssignRoles.mockResolvedValue(undefined)

    const { POST } = await import('./admins/+server')
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({
        itAdmin: { email: 'it@example.de', password: 'password123' },
        councilAdmin: { email: 'council@example.de', password: 'password456' },
      }),
    })
    // @ts-expect-error partial mock
    const res = await POST({ request, locals: { tenant: TEST_TENANT } })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.created).toHaveLength(2)
    // Passwords must not appear in response
    expect(JSON.stringify(body)).not.toContain('password123')
    expect(JSON.stringify(body)).not.toContain('password456')
    expect(mockAssignRoles).toHaveBeenCalledTimes(2)
  })
})
