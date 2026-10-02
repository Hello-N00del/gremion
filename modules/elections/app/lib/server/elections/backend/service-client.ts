// gremion-ui/src/lib/server/elections/backend/service-client.ts
// HTTP ACL client: implements VotesBackendPort over the votes-service leaf
// (VOTES_SERVICE_URL). Only active when VOTES_BACKEND=service (the HELD cutover);
// unused at runtime while the flag is OFF, but pinned by service-client.test.ts
// against contracts/votes/openapi.votes-internal.json.
//
// The leaf is a THIN proxy: it owns the Helios satellite read + Nextcloud Polls +
// aggregator composition (listVotes) and the quick-poll create (createPoll). The
// kernel forwards x-internal-auth (INTERNAL_VOTES_SECRET) + x-tenant-id +
// x-tenant-slug (+ x-correlation-id) on every request. listVotes is an idempotent
// read (retries ONCE on a network error or 503); createPoll is a write (never
// retries). Timeout: 5000ms per attempt.
//
// Mirrors the pattern in files/backend/service-client.ts.

import { getTenant } from '$lib/server/tenant/context'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type { CreatePollInput, VotesBackendPort, VotesListResult } from './port'

/** Thrown when the votes leaf returns a non-2xx response. `status` mirrors the
 *  HTTP status so callers can map it to SvelteKit errors / Responses. */
export class VotesServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[votes-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'VotesServiceError'
    this.status = status
  }
}

export interface ServiceVotesClientOptions {
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
  /** Optional injectable fetch implementation (for testing). Defaults to globalThis.fetch. */
  fetchImpl?: typeof globalThis.fetch
}

const REQUEST_TIMEOUT_MS = 5000

function resolveServiceUrl(): string {
  const url = process.env.VOTES_SERVICE_URL
  if (!url) {
    throw new Error(
      '[votes-service-client] VOTES_SERVICE_URL is not set. ' +
        "Configure it to point to the votes leaf service (e.g. 'http://votes-service:8080').",
    )
  }
  return url.replace(/\/$/, '')
}

function resolveSecret(): string {
  const secret = process.env.INTERNAL_VOTES_SECRET
  if (!secret) {
    throw new Error(
      '[votes-service-client] INTERNAL_VOTES_SECRET is not set. ' +
        'The votes leaf requires this shared secret in x-internal-auth.',
    )
  }
  return secret
}

export class ServiceVotesClient implements VotesBackendPort {
  readonly kind = 'service' as const

  private readonly correlationId: string | undefined
  private readonly tracer: TracerPort
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(opts: ServiceVotesClientOptions = {}) {
    this.correlationId = opts.correlationId
    this.tracer = opts.tracer ?? noopTracer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const secret = resolveSecret()
    const tenant = getTenant()
    const headers: Record<string, string> = {
      'x-internal-auth': secret,
      'x-tenant-id': tenant.id,
      'x-tenant-slug': tenant.slug,
      ...extra,
    }
    if (this.correlationId) headers['x-correlation-id'] = this.correlationId
    return headers
  }

  private async doFetch(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: BodyInit | undefined,
  ): Promise<Response> {
    const url = `${resolveServiceUrl()}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await this.fetchImpl(url, { method, headers, body, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /** JSON leaf call. Serializes `body` as JSON, parses the JSON response. `op`
   *  binds the votes.acl.<op> span; `idempotent` retries ONCE on a network error
   *  or 503. Throws VotesServiceError on a non-2xx. */
  private async leafJson<T>(
    op: string,
    path: string,
    body: unknown,
    idempotent: boolean,
  ): Promise<T> {
    const headers = this.buildHeaders({ 'content-type': 'application/json' })
    const span = this.tracer.startSpan(`votes.acl.${op}`, {
      correlationId: this.correlationId ?? 'none',
    })
    try {
      const payload = body !== undefined ? JSON.stringify(body) : undefined
      let res: Response
      try {
        res = await this.doFetch('POST', path, headers, payload)
        if (res.status === 503 && idempotent) res = await this.doFetch('POST', path, headers, payload)
      } catch (err) {
        if (idempotent) {
          res = await this.doFetch('POST', path, headers, payload)
        } else {
          throw err
        }
      }
      if (!res.ok) {
        const msg = await res.text().catch(() => `HTTP ${res.status}`)
        throw new VotesServiceError(res.status, msg.slice(0, 200))
      }
      const parsed = (await res.json()) as T
      span.end()
      return parsed
    } catch (err) {
      span.end(err)
      throw err
    }
  }

  async listVotes(electionUuids: readonly string[]): Promise<VotesListResult> {
    const res = await this.leafJson<VotesListResult>(
      'list-votes',
      '/api/v1/votes',
      { electionUuids: [...electionUuids] },
      true,
    )
    return {
      votes: res.votes ?? [],
      degradedUuids: res.degradedUuids ?? [],
      pollError: res.pollError ?? null,
    }
  }

  async createPoll(input: CreatePollInput): Promise<void> {
    await this.leafJson('create-poll', '/api/v1/polls', input, false)
  }
}
