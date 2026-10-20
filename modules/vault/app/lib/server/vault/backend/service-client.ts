// gremion-ui/src/lib/server/vault/backend/service-client.ts
// HTTP ACL client: implements VaultBackendPort over the vault leaf service
// (VAULT_SERVICE_URL). Mirrors the board/calendar/newsletter service clients.
//
// Retry policy: ONE retry on idempotent GET/HEAD requests only (never on
// POST/DELETE). Retry only on network errors or 503. Timeout 5000ms/attempt.
//
// Vault-specific: revealSecret is a GET to /items/:id/secret (the leaf's real
// reveal seam), but the leaf writes ONE access_log row per reveal attempt — so
// this call opts OUT of the idempotent-GET retry (allowRetry=false) and surfaces
// the error; a retried reveal would double-audit. The acting user id travels in
// the x-vault-user-id header so the leaf records WHO revealed each secret.

import { getTenant } from '$lib/server/tenant/context'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type {
  VaultBackendPort,
  VaultItem,
  CreateVaultItemInput,
  UpdateVaultItemInput,
  VaultAccessLogEntry,
  RevealedSecret,
} from './port'

// ── Error class ───────────────────────────────────────────────────────────────

/** Thrown when the vault leaf returns a non-2xx response. `status` mirrors the
 *  HTTP status so callers can map it to SvelteKit errors / Responses. */
export class VaultServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[vault-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'VaultServiceError'
    this.status = status
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ServiceVaultClientOptions {
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
  /** Optional injectable fetch implementation (for testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch
}

const REQUEST_TIMEOUT_MS = 5000
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function resolveServiceUrl(): string {
  const url = process.env.VAULT_SERVICE_URL
  if (!url) {
    throw new Error(
      '[vault-service-client] VAULT_SERVICE_URL is not set. ' +
        "Configure it to point to the vault leaf service (e.g. 'http://vault-service:8080').",
    )
  }
  return url.replace(/\/$/, '')
}

function resolveSecret(): string {
  const secret = process.env.INTERNAL_VAULT_SECRET
  if (!secret) {
    throw new Error(
      '[vault-service-client] INTERNAL_VAULT_SECRET is not set. ' +
        'The vault leaf requires this shared secret in x-internal-auth.',
    )
  }
  return secret
}

// ── Deserialization ──────────────────────────────────────────────────────────
// The leaf returns an ISO string for the TIMESTAMPTZ created_at column; coerce it
// back to a Date so callers get the same VaultItem shape everywhere. The secret
// is NEVER on this shape.

function deserializeItem(raw: Record<string, unknown>): VaultItem {
  return {
    id: raw.id as string,
    org_unit_id: raw.org_unit_id as string,
    name: raw.name as string,
    username: (raw.username as string | null) ?? null,
    url: (raw.url as string | null) ?? null,
    notes: (raw.notes as string | null) ?? null,
    created_by: (raw.created_by as string | null) ?? null,
    created_at: new Date(raw.created_at as string),
  }
}

/** The leaf's access-log rows arrive with an ISO accessed_at; coerce to Date
 *  (mirrors deserializeItem). */
function deserializeAccessLogEntry(raw: Record<string, unknown>): VaultAccessLogEntry {
  return {
    id: raw.id as string,
    item_id: raw.item_id as string,
    item_name: raw.item_name as string,
    org_unit_id: raw.org_unit_id as string,
    accessed_by: raw.accessed_by as string,
    accessed_at: new Date(raw.accessed_at as string),
  }
}

/** Read the `{ data: [...] }` list envelope the leaf's list route returns. Throws
 *  on an unexpected shape instead of coercing a malformed 200 into an empty list
 *  (a silent empty coercion would hide items from a scoped member). */
function readDataArray(res: unknown, op: string): unknown[] {
  const data = (res as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new Error(
      `[vault-service-client] malformed ${op} response: expected { data: [...] } from the vault leaf`,
    )
  }
  return data
}

// ── ServiceVaultClient ────────────────────────────────────────────────────────

export class ServiceVaultClient implements VaultBackendPort {
  readonly kind = 'service' as const

  private readonly correlationId: string | undefined
  private readonly tracer: TracerPort
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: ServiceVaultClientOptions = {}) {
    this.correlationId = opts.correlationId
    this.tracer = opts.tracer ?? noopTracer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const secret = resolveSecret()
    const tenant = getTenant()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-internal-auth': secret,
      'x-tenant-id': tenant.id,
      'x-tenant-slug': tenant.slug,
    }
    if (this.correlationId) headers['x-correlation-id'] = this.correlationId
    if (extra) Object.assign(headers, extra)
    return headers
  }

  private async doLeafFetch(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const url = `${resolveServiceUrl()}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`
        try {
          const errBody = (await res.json()) as { error?: string }
          if (errBody.error) errMsg = errBody.error
        } catch {
          /* ignore JSON parse failure */
        }
        throw new VaultServiceError(res.status, errMsg)
      }
      // A 204 (e.g. a successful DELETE) has no body — never call res.json() on it.
      if (res.status === 204) return undefined
      return res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  /** Execute a leaf HTTP call wrapped in a 'vault.acl.<op>' span. Retries once on
   *  idempotent GET/HEAD for network errors or 503 — UNLESS the caller opts out
   *  via allowRetry=false (the reveal GET does, so it is never double-audited). */
  private async leafFetch(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    allowRetry: boolean = IDEMPOTENT_METHODS.has(method.toUpperCase()),
  ): Promise<unknown> {
    const headers = this.buildHeaders(extraHeaders)
    const span = this.tracer.startSpan(`vault.acl.${method} ${path}`, {
      correlationId: this.correlationId ?? 'none',
    })
    try {
      let result: unknown
      try {
        result = await this.doLeafFetch(method, path, body, headers)
      } catch (err) {
        if (allowRetry && (!(err instanceof VaultServiceError) || err.status === 503)) {
          result = await this.doLeafFetch(method, path, body, headers)
        } else {
          throw err
        }
      }
      span.end()
      return result
    } catch (err) {
      span.end(err)
      throw err
    }
  }

  async listItemsForOrgUnits(orgUnitIds: readonly string[]): Promise<readonly VaultItem[]> {
    // Empty scope short-circuits to [] without a leaf call.
    if (orgUnitIds.length === 0) return []
    const params = new URLSearchParams()
    for (const id of orgUnitIds) params.append('orgUnitId', id)
    const res = await this.leafFetch('GET', `/items?${params.toString()}`)
    return readDataArray(res, 'listItemsForOrgUnits').map((i) =>
      deserializeItem(i as Record<string, unknown>),
    )
  }

  async getItem(id: string): Promise<VaultItem | null> {
    try {
      const res = (await this.leafFetch('GET', `/items/${encodeURIComponent(id)}`)) as Record<
        string,
        unknown
      >
      return deserializeItem(res)
    } catch (err) {
      if (err instanceof VaultServiceError && err.status === 404) return null
      throw err
    }
  }

  async revealSecret(id: string, userId: string): Promise<RevealedSecret> {
    // The reveal seam is GET /items/:id/secret. The leaf logs one access_log row
    // per attempt, so this call opts OUT of the idempotent-GET retry (allowRetry
    // = false): a retried reveal would double-audit. The acting user id travels in
    // x-vault-user-id so the leaf records WHO revealed the secret.
    const res = (await this.leafFetch(
      'GET',
      `/items/${encodeURIComponent(id)}/secret`,
      undefined,
      { 'x-vault-user-id': userId },
      false,
    )) as Record<string, unknown>
    if (typeof res.secret !== 'string') {
      throw new Error(
        '[vault-service-client] malformed reveal response: expected { secret: string } from the vault leaf',
      )
    }
    return { secret: res.secret }
  }

  async createItem(data: CreateVaultItemInput): Promise<VaultItem> {
    const res = (await this.leafFetch('POST', '/items', data)) as Record<string, unknown>
    return deserializeItem(res)
  }

  async updateItem(id: string, data: UpdateVaultItemInput): Promise<VaultItem | null> {
    // PUT is not in the idempotent-retry set — a mutation is never auto-retried.
    try {
      const res = (await this.leafFetch(
        'PUT',
        `/items/${encodeURIComponent(id)}`,
        data,
      )) as Record<string, unknown>
      return deserializeItem(res)
    } catch (err) {
      if (err instanceof VaultServiceError && err.status === 404) return null
      throw err
    }
  }

  async listAccessLog(
    orgUnitIds: readonly string[],
    opts: { limit: number; offset: number },
  ): Promise<readonly VaultAccessLogEntry[]> {
    // Empty scope short-circuits to [] without a leaf call (the leaf 400s an
    // empty orgUnitIds csv — required param).
    if (orgUnitIds.length === 0) return []
    const params = new URLSearchParams({
      orgUnitIds: orgUnitIds.join(','),
      limit: String(opts.limit),
      offset: String(opts.offset),
    })
    const res = await this.leafFetch('GET', `/access-log?${params.toString()}`)
    return readDataArray(res, 'listAccessLog').map((e) =>
      deserializeAccessLogEntry(e as Record<string, unknown>),
    )
  }

  async deleteItem(id: string): Promise<boolean> {
    try {
      await this.leafFetch('DELETE', `/items/${encodeURIComponent(id)}`)
      return true
    } catch (err) {
      if (err instanceof VaultServiceError && err.status === 404) return false
      throw err
    }
  }
}
