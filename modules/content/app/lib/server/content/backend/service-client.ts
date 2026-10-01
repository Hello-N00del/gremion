// gremion-ui/src/lib/server/content/backend/service-client.ts
// Task 3 — HTTP ACL client: implements ContentBackendPort over the
// content leaf service (CONTENT_SERVICE_URL).
//
// Response envelope: the leaf returns bare JSON values (no { data: T } wrapper).
//   Lists  → T[]        (e.g. GET /api/v1/posts → Post[])
//   Singles → T         (e.g. POST /api/v1/posts → Post)
//   Void   → 204 / no body
//
// Retry policy: ONE retry on idempotent GET/HEAD requests only (not on
// POST/PUT/PATCH/DELETE). Retry only on network errors or 503 responses.
// Timeout: 5000ms per attempt, body read included; the synchronous per-channel
// publish gets PUBLISH_TIMEOUT_MS (K5#1). Every path param goes through seg()
// (F1-FIX-07 H08): one value, one encoded segment, dot segments refused.
//
// Deviation from newsletter service-client:
//   - fetchImpl is an injectable instance field (not module-level) for test injection.
//   - doLeafFetch / leafFetch are instance methods using this.fetchImpl.
//   - No { data: T } envelope — leaf returns bare JSON.

import { getTenant } from '$lib/server/tenant/context'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import { ChannelNotPublishableError } from '../publish-errors'
import type {
  ChannelId,
  ChannelStatus,
  ClaimResult,
  ContentBackendPort,
  MailingList,
  MailingListMember,
  MediaRole,
  Post,
  PostChannel,
  PostMedia,
  PostRecipient,
  Publication,
  PublishOp,
  PublishResult,
} from './port'

// ── Error class ───────────────────────────────────────────────────────────────

/**
 * Thrown when the content leaf returns a non-2xx response. `status` mirrors
 * the HTTP status code so callers can map it to SvelteKit errors / Responses.
 */
export class ContentServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[content-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'ContentServiceError'
    this.status = status
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ServiceContentClientOptions {
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
}

const REQUEST_TIMEOUT_MS = 5000
/**
 * K5#1: the per-channel publish is synchronous and loops over every recipient
 * on the leaf, so the 5 s CRUD budget aborted real sends mid-pass. It gets its
 * own budget, kept BELOW the leaf's 15-minute stale-claim window so a publish
 * this client gave up on can never overlap a takeover of its own claims.
 */
const PUBLISH_TIMEOUT_MS = 10 * 60_000
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD'])

/**
 * F1-FIX-07 H08 (K5#27): one route-supplied value becomes exactly ONE leaf path
 * segment. SvelteKit hands routes DECODED params, so an id like
 * `x/../../lists` would otherwise walk the leaf URL to an author-only endpoint
 * (subscriber emails). encodeURIComponent keeps `/`, `?`, `#` inside the
 * segment; '.', '..' and '' are refused outright because the WHATWG URL parser
 * collapses dot segments even when percent-encoded.
 */
function seg(value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new ContentServiceError(400, 'invalid path segment')
  }
  return encodeURIComponent(value)
}

/** One leaf attempt, fully read: the body is consumed under the same timer. */
interface LeafReply {
  status: number
  ok: boolean
  text: string
}

// ── ServiceContentClient ──────────────────────────────────────────────────────

export class ServiceContentClient implements ContentBackendPort {
  readonly kind = 'service' as const

  private readonly correlationId: string | undefined
  private readonly tracer: TracerPort

  /** Injectable fetch implementation — override in tests via (c as any).fetchImpl. */
  fetchImpl: typeof globalThis.fetch = globalThis.fetch

  constructor(opts: ServiceContentClientOptions = {}) {
    this.correlationId = opts.correlationId
    this.tracer = opts.tracer ?? noopTracer
  }

  // ── Config helpers ─────────────────────────────────────────────────────────

  private resolveServiceUrl(): string {
    const url = process.env.CONTENT_SERVICE_URL
    if (!url) {
      throw new Error(
        '[content-service-client] CONTENT_SERVICE_URL is not set. ' +
          "Configure it to point to the content leaf service (e.g. 'http://content:3002').",
      )
    }
    return url.replace(/\/$/, '')
  }

  private resolveSecret(): string {
    const secret = process.env.INTERNAL_CONTENT_SECRET
    if (!secret) {
      throw new Error(
        '[content-service-client] INTERNAL_CONTENT_SECRET is not set. ' +
          'The content leaf requires this shared secret in x-internal-auth.',
      )
    }
    return secret
  }

  // ── Header builder ─────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const secret = this.resolveSecret()
    const tenant = getTenant()
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-internal-auth': secret,
      'x-tenant-id': tenant.id,
      'x-tenant-slug': tenant.slug,
    }
    // Tenancy D1 HARDENING-3: no `x-tenant-host`. The kernel used to tell each
    // leaf the tenant's registered hostname here so the leaf's OWN callbacks
    // could carry one back as x-forwarded-host. It no longer needs to: the
    // kernel resolves a callback's tenant from the `x-tenant-id` the leaf
    // already asserts (tenant/leaf-trust.ts), so the leaf holds no hostname and
    // there is nothing to keep in sync, back-fill, or invalidate.
    if (this.correlationId) {
      headers['x-correlation-id'] = this.correlationId
    }
    return headers
  }

  // ── Core fetch with retry ──────────────────────────────────────────────────

  /**
   * Single HTTP attempt. The timer covers the whole exchange — headers AND body
   * (K5#1: it used to be cleared before res.json(), so a stalled body read hung
   * the request forever). No status handling here.
   */
  private async doLeafFetch(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<LeafReply> {
    const baseUrl = this.resolveServiceUrl()
    const url = `${baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const text = res.status === 204 ? '' : await res.text()
      return { status: res.status, ok: res.ok, text }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Execute a leaf HTTP call with ONE retry for idempotent GET/HEAD on 503 or network error.
   * POSTs are never retried.
   * 404 → returns null when nullable=true, throws ContentServiceError otherwise.
   * All other non-2xx → ContentServiceError.
   * Returns parsed JSON body or undefined for 204 No Content.
   */
  private async leafFetch(
    method: string,
    path: string,
    body?: unknown,
    nullable = false,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const headers = this.buildHeaders()
    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase())
    const span = this.tracer.startSpan(`content.acl.${method} ${path}`, {
      correlationId: this.correlationId ?? 'none',
    })

    const attempt = () => this.doLeafFetch(method, path, body, headers, timeoutMs)

    let res: LeafReply
    try {
      res = await attempt()
      // Retry once on idempotent + 503
      if (isIdempotent && res.status === 503) {
        res = await attempt()
      }
    } catch (networkErr) {
      // Network error (AbortError, TypeError etc.) — retry once for GET/HEAD only
      if (isIdempotent) {
        try {
          res = await attempt()
        } catch (retryErr) {
          span.end(retryErr)
          throw retryErr
        }
      } else {
        span.end(networkErr)
        throw networkErr
      }
    }

    if (res.status === 404 && nullable) {
      span.end()
      return null
    }

    if (!res.ok) {
      const err = new ContentServiceError(res.status, res.text || `HTTP ${res.status}`)
      span.end(err)
      throw err
    }

    span.end()
    if (res.status === 204 || res.text === '') return undefined
    return JSON.parse(res.text) as unknown
  }

  // ── Post CRUD ─────────────────────────────────────────────────────────────

  async createPost(input: { title: string; created_by: string }): Promise<Post> {
    return (await this.leafFetch('POST', '/api/v1/posts', input)) as Post
  }

  async getPost(id: string): Promise<Post | null> {
    return (await this.leafFetch('GET', `/api/v1/posts/${seg(id)}`, undefined, true)) as Post | null
  }

  async listPosts(): Promise<Post[]> {
    return (await this.leafFetch('GET', '/api/v1/posts')) as Post[]
  }

  async updatePostTitle(id: string, title: string): Promise<Post> {
    return (await this.leafFetch('PATCH', `/api/v1/posts/${seg(id)}`, { title })) as Post
  }

  async updatePostBody(id: string, bodyHtml: string): Promise<Post> {
    return (await this.leafFetch('PATCH', `/api/v1/posts/${seg(id)}`, {
      body_html: bodyHtml,
    })) as Post
  }

  async deletePost(id: string): Promise<void> {
    await this.leafFetch('DELETE', `/api/v1/posts/${seg(id)}`)
  }

  // ── Media ─────────────────────────────────────────────────────────────────

  async listMedia(postId: string): Promise<PostMedia[]> {
    return (await this.leafFetch('GET', `/api/v1/posts/${seg(postId)}/media`)) as PostMedia[]
  }

  async addMedia(
    postId: string,
    m: { url: string; role: MediaRole; position?: number; alt?: string | null },
  ): Promise<PostMedia> {
    return (await this.leafFetch('POST', `/api/v1/posts/${seg(postId)}/media`, m)) as PostMedia
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  async getChannels(postId: string): Promise<PostChannel[]> {
    return (await this.leafFetch('GET', `/api/v1/posts/${seg(postId)}/channels`)) as PostChannel[]
  }

  async ensureChannels(postId: string): Promise<void> {
    await this.leafFetch('POST', `/api/v1/posts/${seg(postId)}/channels`)
  }

  async setChannelEnabled(
    postId: string,
    channel: ChannelId,
    enabled: boolean,
  ): Promise<PostChannel> {
    return (await this.leafFetch('PATCH', `/api/v1/posts/${seg(postId)}/channels/${seg(channel)}`, {
      enabled,
    })) as PostChannel
  }

  async setChannelStatus(
    postId: string,
    channel: ChannelId,
    status: ChannelStatus,
  ): Promise<PostChannel> {
    return (await this.leafFetch('PATCH', `/api/v1/posts/${seg(postId)}/channels/${seg(channel)}`, {
      status,
    })) as PostChannel
  }

  async setChannelScheduledAt(
    postId: string,
    channel: ChannelId,
    scheduledAt: string | null,
  ): Promise<PostChannel> {
    return (await this.leafFetch('PATCH', `/api/v1/posts/${seg(postId)}/channels/${seg(channel)}`, {
      scheduled_at: scheduledAt,
    })) as PostChannel
  }

  async setChannelOverrides(
    postId: string,
    channel: ChannelId,
    overrides: Record<string, unknown>,
  ): Promise<PostChannel> {
    return (await this.leafFetch('PATCH', `/api/v1/posts/${seg(postId)}/channels/${seg(channel)}`, {
      overrides,
    })) as PostChannel
  }

  // ── Mailing lists ──────────────────────────────────────────────────────────

  async createMailingList(name: string): Promise<MailingList> {
    return (await this.leafFetch('POST', '/api/v1/lists', { name })) as MailingList
  }

  async listMailingLists(): Promise<MailingList[]> {
    return (await this.leafFetch('GET', '/api/v1/lists')) as MailingList[]
  }

  async deleteMailingList(id: string): Promise<void> {
    await this.leafFetch('DELETE', `/api/v1/lists/${seg(id)}`)
  }

  // ── Mailing list members ───────────────────────────────────────────────────

  async addListMember(
    listId: string,
    m: { email: string; name?: string | null; source?: 'manual' | 'csv' },
  ): Promise<void> {
    await this.leafFetch('POST', `/api/v1/lists/${seg(listId)}/members`, m)
  }

  async listMembers(listId: string): Promise<MailingListMember[]> {
    return (await this.leafFetch('GET', `/api/v1/lists/${seg(listId)}/members`)) as MailingListMember[]
  }

  async removeListMember(listId: string, memberId: string): Promise<void> {
    await this.leafFetch('DELETE', `/api/v1/lists/${seg(listId)}/members/${seg(memberId)}`)
  }

  // ── Recipients ────────────────────────────────────────────────────────────

  async setPostRecipients(
    postId: string,
    recips: { mailing_list_id?: string; keycloak_group_id?: string }[],
  ): Promise<void> {
    await this.leafFetch('PUT', `/api/v1/posts/${seg(postId)}/recipients`, { recipients: recips })
  }

  async getPostRecipients(postId: string): Promise<PostRecipient[]> {
    return (await this.leafFetch('GET', `/api/v1/posts/${seg(postId)}/recipients`)) as PostRecipient[]
  }

  // ── Unsubscribe ───────────────────────────────────────────────────────────

  async isUnsubscribed(email: string): Promise<boolean> {
    // No dedicated single-email endpoint; use the filter endpoint
    const set = await this.filterUnsubscribed([email])
    return set.has(email)
  }

  async filterUnsubscribed(emailsLower: string[]): Promise<Set<string>> {
    const arr = (await this.leafFetch('POST', '/api/v1/unsubscribe', {
      action: 'filter',
      emails: emailsLower,
    })) as string[]
    return new Set(arr)
  }

  async addUnsubscribe(email: string): Promise<void> {
    await this.leafFetch('POST', '/api/v1/unsubscribe', { action: 'add', email })
  }

  // ── Send tokens ───────────────────────────────────────────────────────────

  /**
   * Issues POST /api/v1/posts/{id}/recipients (NOT the same as setPostRecipients which is PUT).
   * Task 21 leaf implementer: add a POST handler on /api/v1/posts/:id/recipients that dispatches
   * on action='mint-token' to issue and return a single-use send token string.
   */
  async mintSendToken(postId: string, email: string): Promise<string> {
    return (await this.leafFetch('POST', `/api/v1/posts/${seg(postId)}/recipients`, {
      action: 'mint-token',
      email,
    })) as string
  }

  async consumeUnsubscribeToken(
    token: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }> {
    try {
      return (await this.leafFetch('POST', '/api/v1/unsubscribe', {
        action: 'consume-token',
        token,
      })) as { ok: true } | { ok: false; reason: 'invalid' | 'expired' }
    } catch (err) {
      if (err instanceof ContentServiceError && (err.status === 404 || err.status === 410)) {
        const reason = err.status === 410 ? 'expired' : 'invalid'
        return { ok: false, reason }
      }
      throw err
    }
  }

  // ── Delivery ledger ───────────────────────────────────────────────────────

  async claimRecipient(postId: string, emailLower: string): Promise<ClaimResult> {
    return (await this.leafFetch('POST', '/api/v1/deliveries/claim', {
      post_id: postId,
      email: emailLower,
    })) as ClaimResult
  }

  async markDeliverySent(postId: string, emailLower: string, messageId: string): Promise<void> {
    await this.leafFetch(
      'POST',
      `/api/v1/deliveries/${seg(postId)}/${seg(emailLower)}/sent`,
      { message_id: messageId },
    )
  }

  async markDeliveryFailed(postId: string, emailLower: string, error: string): Promise<void> {
    await this.leafFetch(
      'POST',
      `/api/v1/deliveries/${seg(postId)}/${seg(emailLower)}/failed`,
      { error },
    )
  }

  // ── Publications ──────────────────────────────────────────────────────────

  async getPublication(postId: string, channel: ChannelId): Promise<Publication | null> {
    return (await this.leafFetch(
      'GET',
      `/api/v1/publications/${seg(postId)}/${seg(channel)}`,
      undefined,
      true,
    )) as Publication | null
  }

  async setPublication(
    postId: string,
    channel: ChannelId,
    externalRef: string | null,
  ): Promise<void> {
    await this.leafFetch('PUT', `/api/v1/publications/${seg(postId)}/${seg(channel)}`, {
      external_ref: externalRef,
    })
  }

  async clearPublication(postId: string, channel: ChannelId): Promise<void> {
    await this.leafFetch('DELETE', `/api/v1/publications/${seg(postId)}/${seg(channel)}`)
  }

  // ── Publish operations ────────────────────────────────────────────────────

  async enqueuePublishOp(postId: string, channel: 'instagram', op: 'publish'): Promise<void> {
    await this.leafFetch('POST', '/api/v1/publish-ops', { action: 'enqueue', post_id: postId, channel, op })
  }

  async listDuePublishOps(): Promise<PublishOp[]> {
    return (await this.leafFetch('GET', '/api/v1/publish-ops/due')) as PublishOp[]
  }

  async markPublishOpOk(opId: string, externalRef?: string): Promise<void> {
    await this.leafFetch('POST', `/api/v1/publish-ops`, {
      action: 'mark-ok',
      op_id: opId,
      external_ref: externalRef ?? null,
    })
  }

  async markPublishOpFailed(opId: string, error: string): Promise<void> {
    await this.leafFetch('POST', `/api/v1/publish-ops`, {
      action: 'mark-failed',
      op_id: opId,
      error,
    })
  }

  // ── Per-channel publish ────────────────────────────────────────────────────

  /**
   * Delegate a per-channel publish to the leaf's synchronous publish endpoint
   * (POST /api/v1/posts/:id/publish/:channel). The leaf runs the same per-channel
   * path against its own DB + kernel callbacks and returns the PublishResult.
   *
   * A leaf 409 (post unknown / channel missing or disabled) is re-thrown as the
   * kernel's ChannelNotPublishableError so the route's `instanceof` branch maps it
   * to a 409 identically to the inprocess path. An email 'failed' result comes
   * back as a 200 body (the route turns it into a 422), so it is NOT an error here.
   *
   * NOT retried (POST): a publish is not idempotent-safe to blind-retry at the
   * transport layer — the leaf's own per-recipient / publication idempotency owns
   * de-duplication on an explicit re-publish.
   */
  async publish(postId: string, channel: ChannelId): Promise<PublishResult> {
    try {
      return (await this.leafFetch(
        'POST',
        `/api/v1/posts/${seg(postId)}/publish/${seg(channel)}`,
        undefined,
        false,
        PUBLISH_TIMEOUT_MS,
      )) as PublishResult
    } catch (err) {
      if (err instanceof ContentServiceError && err.status === 409) {
        throw new ChannelNotPublishableError('content channel is not in a publishable state')
      }
      throw err
    }
  }
}
