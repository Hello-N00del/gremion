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
  readonly enabled?: boolean
}

interface TokenCache {
  token: string
  expiresAt: number
}

export class KeycloakAdminClient {
  private readonly adminUrl: string
  private readonly realm: string
  private readonly clientId: string
  private readonly clientSecret: string
  private tokenCache: TokenCache | null = null

  constructor(adminUrl: string, realm: string, clientId: string, clientSecret: string) {
    this.adminUrl = adminUrl
    this.realm = realm
    this.clientId = clientId
    this.clientSecret = clientSecret
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

  private async getToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt - 30_000) {
      return this.tokenCache.token
    }

    const res = await fetch(
      `${this.adminUrl}/realms/${this.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret
        }).toString()
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
      body: body !== undefined ? JSON.stringify(body) : undefined
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Keycloak Admin API error: ${res.status} ${text}`)
    }

    // 204 No Content — return empty
    if (res.status === 204) return undefined as T

    return res.json() as Promise<T>
  }

  async listUsers(opts?: ListUsersOptions): Promise<readonly KcUser[]> {
    const params = new URLSearchParams()
    params.set('first', String(opts?.first ?? 0))
    params.set('max', String(opts?.max ?? 25))
    if (opts?.search) params.set('search', opts.search)
    if (opts?.enabled !== undefined) params.set('enabled', String(opts.enabled))
    return this.request<KcUser[]>('GET', `/users?${params}`)
  }

  async getUser(id: string): Promise<KcUser> {
    try {
      return await this.request<KcUser>('GET', `/users/${id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('404')) throw new Error('User not found')
      throw err
    }
  }

  async createUser(data: KcUserCreate): Promise<string> {
    const token = await this.getToken()
    const res = await fetch(`${this.adminUrl}/admin/realms/${this.realm}/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Keycloak Admin API error: ${res.status} ${text}`)
    }

    const location = res.headers.get('Location') ?? ''
    const id = location.split('/').at(-1) ?? ''
    if (!id) throw new Error('Keycloak createUser: no Location header in response')
    return id
  }

  async updateUser(id: string, data: KcUserUpdate): Promise<void> {
    return this.request<void>('PUT', `/users/${id}`, data)
  }

  async deleteUser(id: string): Promise<void> {
    return this.request<void>('DELETE', `/users/${id}`)
  }

  async listUserGroups(id: string): Promise<readonly KcGroup[]> {
    return this.request<KcGroup[]>('GET', `/users/${id}/groups`)
  }

  async addUserToGroup(userId: string, groupId: string): Promise<void> {
    return this.request<void>('PUT', `/users/${userId}/groups/${groupId}`)
  }

  async removeUserFromGroup(userId: string, groupId: string): Promise<void> {
    return this.request<void>('DELETE', `/users/${userId}/groups/${groupId}`)
  }

  async listUserRoles(id: string): Promise<readonly KcRole[]> {
    return this.request<KcRole[]>('GET', `/users/${id}/role-mappings/realm`)
  }

  async assignRoles(userId: string, roles: readonly KcRole[]): Promise<void> {
    return this.request<void>('POST', `/users/${userId}/role-mappings/realm`, [...roles])
  }

  async listRealmRoles(): Promise<readonly KcRole[]> {
    return this.request<KcRole[]>('GET', '/roles')
  }

  async executeActionsEmail(userId: string, actions: readonly string[]): Promise<void> {
    return this.request<void>('PUT', `/users/${userId}/execute-actions-email`, [...actions])
  }

  async listGroups(): Promise<readonly KcGroup[]> {
    return this.request<KcGroup[]>('GET', '/groups')
  }

  /** Direct children of a group (one level). Used to adopt an existing same-name
   *  subgroup so re-provisioning is idempotent against leftover Keycloak state. */
  async listSubGroups(parentId: string): Promise<readonly KcGroup[]> {
    return this.request<KcGroup[]>('GET', `/groups/${parentId}/children`)
  }

  async getGroup(id: string): Promise<KcGroup> {
    try {
      return await this.request<KcGroup>('GET', `/groups/${id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('404')) throw new Error('Group not found')
      throw err
    }
  }

  async createGroup(name: string): Promise<string> {
    const token = await this.getToken()
    const res = await fetch(`${this.adminUrl}/admin/realms/${this.realm}/groups`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name })
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Keycloak Admin API error: ${res.status} ${text}`)
    }

    const location = res.headers.get('Location') ?? ''
    const id = location.split('/').at(-1) ?? ''
    if (!id) throw new Error('Keycloak createGroup: no Location header in response')
    return id
  }

  async createSubgroup(parentId: string, name: string): Promise<string> {
    const token = await this.getToken()
    const res = await fetch(
      `${this.adminUrl}/admin/realms/${this.realm}/groups/${parentId}/children`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      }
    )
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Keycloak Admin API error: ${res.status} ${text}`)
    }
    const location = res.headers.get('Location') ?? ''
    const id = location.split('/').at(-1) ?? ''
    if (!id) throw new Error('Keycloak createSubgroup: no Location header in response')
    return id
  }

  async updateGroup(id: string, data: { name?: string; attributes?: Record<string, string[]> }): Promise<void> {
    return this.request<void>('PUT', `/groups/${id}`, data)
  }

  async deleteGroup(id: string): Promise<void> {
    return this.request<void>('DELETE', `/groups/${id}`)
  }

  async listGroupMembers(id: string): Promise<readonly KcUser[]> {
    return this.request<KcUser[]>('GET', `/groups/${id}/members`)
  }

  /** Returns all members of a Keycloak group. Fetches up to 1000 users (typical group size for a student union). */
  async getGroupMembers(groupId: string): Promise<readonly KcUser[]> {
    return this.request<KcUser[]>(
      'GET',
      `/groups/${encodeURIComponent(groupId)}/members?first=0&max=1000`
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
    const creds = await this.request<Array<{ type: string }>>('GET', `/users/${userId}/credentials`)
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
