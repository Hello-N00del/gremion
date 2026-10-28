// Keycloak Admin REST API client (KC 26.1 — do NOT upgrade, see Wave 1 gotchas)
// Uses client-credentials grant; Auth.js cannot do service-account flows.
import { resolveSecret } from '$lib/server/tenant/secrets'
import { getTenant, type TenantContext } from '$lib/server/tenant/context'

export interface KcUser {
  readonly id: string
  readonly username: string
  readonly email: string
  readonly firstName: string
  readonly lastName: string
  readonly enabled: boolean
  readonly emailVerified: boolean
  readonly attributes?: Readonly<Record<string, readonly string[]>>
  readonly createdTimestamp?: number
}

export interface KcGroup {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly attributes?: Readonly<Record<string, readonly string[]>>
}

export interface KcRole {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface KcCredential {
  readonly type: 'password'
  readonly value: string
  readonly temporary: boolean
}

export interface KcUserCreate {
  readonly username: string
  readonly email: string
  readonly firstName?: string
  readonly lastName?: string
  readonly enabled: boolean
  readonly emailVerified: boolean
  readonly credentials?: readonly KcCredential[]
}

export interface KcUserUpdate {
  readonly firstName?: string
  readonly lastName?: string
  readonly enabled?: boolean
  readonly attributes?: Record<string, string[]>
}

export interface ListUsersOptions {
  readonly first?: number
  readonly max?: number
  readonly search?: string
  /** Exact-username lookup (`username=<v>&exact=true`); wins over `search`. */
  readonly username?: string
  readonly exact?: boolean
  readonly enabled?: boolean
}

export interface KeycloakAdminClientOptions {
  /** Per-request budget for every outbound Keycloak fetch (token + admin). */
  readonly timeoutMs?: number
}

/** F1-FIX-01 (K1#8/#38): one hung Keycloak call must not stall a scheduler tick. */
const DEFAULT_TIMEOUT_MS = 15_000

interface TokenCache {
  token: string
  expiresAt: number
}

/**
 * F1-FIX-01 (H03): every id spliced into a realm-admin REST path goes through
 * this. SvelteKit hands route handlers the DECODED param and fetch() collapses
 * `..` segments, so a raw `../clients/x` would steer the service-account token
 * to any admin endpoint. encodeURIComponent turns `/`, `?`, `#` and `%` into
 * data; the bare dot segments survive encoding, so they are rejected outright.
 */
function seg(id: string): string {
  if (typeof id !== 'string' || id === '' || id === '.' || id === '..') {
    throw new Error('Invalid Keycloak id')
  }
  return encodeURIComponent(id)
}

export class KeycloakAdminClient {
  private readonly adminUrl: string
  private readonly realm: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number
  private tokenCache: TokenCache | null = null
  private tokenInflight: Promise<string> | null = null

  constructor(
    adminUrl: string,
    realm: string,
    clientId: string,
    clientSecret: string,
    opts?: KeycloakAdminClientOptions,
  ) {
    this.adminUrl = adminUrl
    this.realm = realm
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Validate that the configured admin client credentials are accepted by
   *  Keycloak (client-credentials grant succeeds). Used by the setup health
   *  check to surface a bad/empty KEYCLOAK_ADMIN_CLIENT_SECRET distinctly from
   *  mere reachability. Returns false on any auth/transport failure rather than
   *  throwing, so the caller can treat it as a boolean probe. */
  async validateCredentials(timeoutMs = 3000): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(
        `${this.adminUrl}/realms/${this.realm}/protocol/openid-connect/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.clientId,
            client_secret: this.clientSecret
          }).toString(),
          signal: controller.signal
        }
      )
      clearTimeout(timer)
      return res.ok
    } catch {
      return false
    }
  }

  private getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 30_000) {
      return Promise.resolve(this.tokenCache.token)
    }
    // Single-flight: concurrent callers on a cold/expired cache share one
    // token request instead of each hitting the token endpoint.
    this.tokenInflight ??= this.fetchToken().finally(() => {
      this.tokenInflight = null
    })
    return this.tokenInflight
  }

  private async fetchToken(): Promise<string> {
    const res = await fetch(
      `${this.adminUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      }
    )

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Keycloak token fetch failed: ${res.status} ${body}`)
    }

    const data = await res.json() as { access_token: string; expires_in: number }
    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000
    }
    return this.tokenCache.token
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.getToken()
    const res = await fetch(`${this.adminUrl}/admin/realms/${this.realm}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs)
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Keycloak Admin API error: ${res.status} ${text}`)
    }

    // 204 No Content — return empty
    if (res.status === 204) return undefined as T

    return res.json() as Promise<T>
  }

  /** POST that answers 201 + Location; returns the trailing id. Path is
   *  already encoded by the caller. */
  private async postCreate(path: string, body: unknown, what: string): Promise<string> {
    const token = await this.getToken()
    const res = await fetch(`${this.adminUrl}/admin/realms/${this.realm}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Keycloak Admin API error: ${res.status} ${text}`)
    }

    const location = res.headers.get('Location') ?? ''
    const id = location.split('/').at(-1) ?? ''
    if (!id) throw new Error(`Keycloak ${what}: no Location header in response`)
    return id
  }

  async listUsers(opts?: ListUsersOptions): Promise<readonly KcUser[]> {
    const params = new URLSearchParams()
    params.set('first', String(opts?.first ?? 0))
    params.set('max', String(opts?.max ?? 25))
    if (opts?.username) {
      params.set('username', opts.username)
      if (opts.exact) params.set('exact', 'true')
    } else if (opts?.search) {
      params.set('search', opts.search)
    }
    if (opts?.enabled !== undefined) params.set('enabled', String(opts.enabled))
    return this.request<KcUser[]>('GET', `/users?${params}`)
  }

  async getUser(id: string): Promise<KcUser> {
    try {
      return await this.request<KcUser>('GET', `/users/${seg(id)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('404')) throw new Error('User not found')
      throw err
    }
  }

  async createUser(data: KcUserCreate): Promise<string> {
    return this.postCreate('/users', data, 'createUser')
  }

  async updateUser(id: string, data: KcUserUpdate): Promise<void> {
    return this.request<void>('PUT', `/users/${seg(id)}`, data)
  }

  async deleteUser(id: string): Promise<void> {
    return this.request<void>('DELETE', `/users/${seg(id)}`)
  }

  async listUserGroups(id: string): Promise<readonly KcGroup[]> {
    return this.request<KcGroup[]>('GET', `/users/${seg(id)}/groups`)
  }

  async addUserToGroup(userId: string, groupId: string): Promise<void> {
    return this.request<void>('PUT', `/users/${seg(userId)}/groups/${seg(groupId)}`)
  }

  async removeUserFromGroup(userId: string, groupId: string): Promise<void> {
    return this.request<void>('DELETE', `/users/${seg(userId)}/groups/${seg(groupId)}`)
  }

  async listUserRoles(id: string): Promise<readonly KcRole[]> {
    // /composite: EFFECTIVE realm roles (direct + composite + group-inherited), so
    // the member-status rank check sees roles granted through groups/composites.
    return this.request<KcRole[]>('GET', `/users/${seg(id)}/role-mappings/realm/composite`)
  }

  async assignRoles(userId: string, roles: readonly KcRole[]): Promise<void> {
    return this.request<void>('POST', `/users/${seg(userId)}/role-mappings/realm`, [...roles])
  }

  async listRealmRoles(): Promise<readonly KcRole[]> {
    return this.request<KcRole[]>('GET', '/roles')
  }

  async executeActionsEmail(userId: string, actions: readonly string[]): Promise<void> {
    return this.request<void>('PUT', `/users/${seg(userId)}/execute-actions-email`, [...actions])
  }

  async listGroups(): Promise<readonly KcGroup[]> {
    return this.request<KcGroup[]>('GET', '/groups')
  }

  /** Direct children of a group (one level). Used to adopt an existing same-name
   *  subgroup so re-provisioning is idempotent against leftover Keycloak state. */
  async listSubGroups(parentId: string): Promise<readonly KcGroup[]> {
    return this.request<KcGroup[]>('GET', `/groups/${seg(parentId)}/children`)
  }

  async getGroup(id: string): Promise<KcGroup> {
    try {
      return await this.request<KcGroup>('GET', `/groups/${seg(id)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('404')) throw new Error('Group not found')
      throw err
    }
  }

  async createGroup(name: string): Promise<string> {
    return this.postCreate('/groups', { name }, 'createGroup')
  }

  async createSubgroup(parentId: string, name: string): Promise<string> {
    return this.postCreate(`/groups/${seg(parentId)}/children`, { name }, 'createSubgroup')
  }

  async updateGroup(id: string, data: { name?: string; attributes?: Record<string, string[]> }): Promise<void> {
    return this.request<void>('PUT', `/groups/${seg(id)}`, data)
  }

  async deleteGroup(id: string): Promise<void> {
    return this.request<void>('DELETE', `/groups/${seg(id)}`)
  }

  async listGroupMembers(id: string): Promise<readonly KcUser[]> {
    return this.request<KcUser[]>('GET', `/groups/${seg(id)}/members`)
  }

  /** Returns all members of a Keycloak group. Fetches up to 1000 users (typical group size for a student union). */
  async getGroupMembers(groupId: string): Promise<readonly KcUser[]> {
    return this.request<KcUser[]>(
      'GET',
      `/groups/${seg(groupId)}/members?first=0&max=1000`
    )
  }

  async setGroupAttribute(groupId: string, key: string, value: string): Promise<void> {
    const group = await this.getGroup(groupId)
    const existing = group.attributes ?? {}
    // Immutable merge — never mutate the fetched group object
    const merged: Record<string, string[]> = { ...existing as Record<string, string[]>, [key]: [value] }
    return this.updateGroup(groupId, { attributes: merged })
  }

  /** #164: true iff the user has an OTP (TOTP) credential enrolled in Keycloak. */
  async hasOtpCredential(userId: string): Promise<boolean> {
    const creds = await this.request<Array<{ type: string }>>('GET', `/users/${seg(userId)}/credentials`)
    return creds.some((c) => c.type === 'otp')
  }
}

// Per-tenant admin-client registry (D-JWKS/#256-6, P2.1b T6): keyed by the
// CANONICAL tenant.id — realm names are not unique across tenants (two tenants
// may share a realm), so the realm must not be the cache key.
const _adminByTenantId = new Map<string, KeycloakAdminClient>()

export function getKeycloakAdminClient(
  tenant: Pick<TenantContext, 'id' | 'realmName' | 'kcAdminUrl' | 'kcClientId' | 'kcClientSecretRef'>,
): KeycloakAdminClient {
  const existing = _adminByTenantId.get(tenant.id)
  if (existing) return existing
  const client = new KeycloakAdminClient(
    tenant.kcAdminUrl, tenant.realmName, tenant.kcClientId, resolveSecret(tenant.kcClientSecretRef),
  )
  _adminByTenantId.set(tenant.id, client)
  return client
}

/** Drop a tenant's cached admin client (tenant suspend/delete, T8 eviction). */
export function evictKeycloakAdminClient(tenantId: string): void {
  _adminByTenantId.delete(tenantId)
}

/** Test seam: clear the per-tenant admin cache. */
export function __resetKcAdminCache(): void {
  _adminByTenantId.clear()
}

/** For callers already inside a resolved TenantContext (ALS). */
export function getKeycloakAdminClientForCurrentTenant(): KeycloakAdminClient {
  return getKeycloakAdminClient(getTenant())
}
