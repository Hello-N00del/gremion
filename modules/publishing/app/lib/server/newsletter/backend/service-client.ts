// gremion-ui/src/lib/server/newsletter/backend/service-client.ts
// Task 14 — HTTP ACL client: implements NewsletterBackendPort over the
// newsletter leaf service (NEWSLETTER_SERVICE_URL).
//
// Port methods with NO corresponding leaf HTTP endpoint throw
// NotSupportedViaServiceError. These are delivery-ledger / scheduler /
// token-mgmt methods that the leaf owns internally; they are NOT part of
// the kernel→leaf API surface (the leaf drives them itself during dispatch).
// Task 15+ will add leaf endpoints as needed.
//
// Retry policy: ONE retry on idempotent GET/HEAD requests only (not on
// POST/PUT/PATCH/DELETE). Retry only on network errors or 503 responses.
// Timeout: 5000ms per attempt.

import { getTenant } from '$lib/server/tenant/context'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type {
  NewsletterBackendPort,
  GroupMemberFetcher,
  MailingList,
  MailingListMember,
  Newsletter,
  NewsletterRecipient,
  ClaimResult,
} from './port'

// ── Error classes ─────────────────────────────────────────────────────────────

/**
 * Thrown for port methods that have no corresponding leaf HTTP endpoint.
 * These are internal-to-leaf operations (delivery ledger, scheduler,
 * token management). The kernel must not call them via the service client.
 */
export class NotSupportedViaServiceError extends Error {
  constructor(method: string) {
    super(
      `[newsletter-service-client] '${method}' is not exposed by the newsletter leaf service. ` +
        'This operation is internal to the leaf (delivery ledger / scheduler / token mgmt). ' +
        'Add a leaf endpoint in Task 15+ if the kernel needs to drive this directly.'
    )
    this.name = 'NotSupportedViaServiceError'
  }
}

/**
 * Thrown when the leaf returns a non-2xx response. `status` mirrors the
 * HTTP status code so callers can map it to SvelteKit errors / Responses.
 */
export class NewsletterServiceError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`[newsletter-service-client] Leaf returned ${status}: ${message}`)
    this.name = 'NewsletterServiceError'
    this.status = status
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ServiceNewsletterClientOptions {
  /** Optional correlation-id forwarded as x-correlation-id to the leaf. */
  correlationId?: string
  /**
   * T16 (D-P1-8): optional TracerPort for span emission.
   * Each leaf HTTP call is wrapped in a 'newsletter.acl.<op>' span.
   * Defaults to noopTracer so existing tests need no change.
   */
  tracer?: TracerPort
}

const REQUEST_TIMEOUT_MS = 5000
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// ── Internal fetch helper ─────────────────────────────────────────────────────

function resolveServiceUrl(): string {
  const url = process.env.NEWSLETTER_SERVICE_URL
  if (!url) {
    throw new Error(
      '[newsletter-service-client] NEWSLETTER_SERVICE_URL is not set. ' +
        "Configure it to point to the newsletter leaf service (e.g. 'http://newsletter:3001')."
    )
  }
  return url.replace(/\/$/, '')
}

function resolveSecret(): string {
  const secret = process.env.INTERNAL_NEWSLETTER_SECRET
  if (!secret) {
    throw new Error(
      '[newsletter-service-client] INTERNAL_NEWSLETTER_SECRET is not set. ' +
        'The newsletter leaf requires this shared secret in x-internal-auth.'
    )
  }
  return secret
}

async function doLeafFetch(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>
): Promise<unknown> {
  const baseUrl = resolveServiceUrl()
  const url = `${baseUrl}${path}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
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
      throw new NewsletterServiceError(res.status, errMsg)
    }
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ── ServiceNewsletterClient ───────────────────────────────────────────────────

export class ServiceNewsletterClient implements NewsletterBackendPort {
  readonly kind = 'service' as const

  private readonly correlationId: string | undefined
  private readonly tracer: TracerPort

  constructor(opts: ServiceNewsletterClientOptions = {}) {
    this.correlationId = opts.correlationId
    this.tracer = opts.tracer ?? noopTracer
  }

  // ── Core fetch with retry ─────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const secret = resolveSecret()
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

  /**
   * Execute a leaf HTTP call wrapped in a 'newsletter.acl.<op>' span.
   * The span name encodes the HTTP method + path so each operation is
   * individually traceable: e.g. 'newsletter.acl.POST /api/v1/newsletters'.
   */
  private async leafFetch(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    const headers = this.buildHeaders()
    const isIdempotent = IDEMPOTENT_METHODS.has(method.toUpperCase())
    // T16 (D-P1-8): wrap in a newsletter.acl.<op> span.
    const span = this.tracer.startSpan(`newsletter.acl.${method} ${path}`, {
      correlationId: this.correlationId ?? 'none',
    })

    try {
      let result: unknown
      try {
        result = await doLeafFetch(method, path, body, headers)
      } catch (err) {
        // ONE retry on idempotent methods only, for network errors or 503
        if (
          isIdempotent &&
          (!(err instanceof NewsletterServiceError) || err.status === 503)
        ) {
          result = await doLeafFetch(method, path, body, headers)
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

  // ── Mailing lists ─────────────────────────────────────────────────────────

  async createMailingList(name: string): Promise<MailingList> {
    const res = (await this.leafFetch('POST', '/api/v1/lists', { name })) as {
      data: MailingList
    }
    return res.data
  }

  async listMailingLists(): Promise<MailingList[]> {
    const res = (await this.leafFetch('GET', '/api/v1/lists')) as {
      data: MailingList[]
    }
    return res.data
  }

  async deleteMailingList(id: number): Promise<void> {
    await this.leafFetch('DELETE', `/api/v1/lists/${id}`)
  }

  // ── Mailing list members ──────────────────────────────────────────────────

  async addMember(
    listId: number,
    email: string,
    name: string | null,
    source: 'csv' | 'manual'
  ): Promise<void> {
    await this.leafFetch('POST', `/api/v1/lists/${listId}/members`, { email, name, source })
  }

  async listMembers(listId: number): Promise<MailingListMember[]> {
    const res = (await this.leafFetch('GET', `/api/v1/lists/${listId}/members`)) as {
      data: MailingListMember[]
    }
    return res.data
  }

  async deleteMember(listId: number, memberId: number): Promise<void> {
    // The leaf DELETE endpoint is /api/v1/lists/:id/members/:memberId. The port
    // now carries the real listId (the consumer route has it), so we build the
    // real list-scoped URL — the prior `lists/0/...` placeholder (F-IMP) is gone.
    // The leaf currently resolves the member by memberId alone, but sending the
    // true listId is forward-compatible if the leaf later validates ownership.
    await this.leafFetch('DELETE', `/api/v1/lists/${listId}/members/${memberId}`)
  }

  // ── Newsletter CRUD ───────────────────────────────────────────────────────

  async createNewsletter(data: {
    title: string
    odt_path: string
    subject: string
    created_by: string
  }): Promise<Newsletter> {
    const res = (await this.leafFetch('POST', '/api/v1/newsletters', data)) as {
      data: Newsletter
    }
    return res.data
  }

  async listNewsletters(): Promise<Newsletter[]> {
    const res = (await this.leafFetch('GET', '/api/v1/newsletters')) as {
      data: Newsletter[]
    }
    return res.data
  }

  async getNewsletter(id: number): Promise<Newsletter | null> {
    try {
      const res = (await this.leafFetch('GET', `/api/v1/newsletters/${id}`)) as {
        data: Newsletter
      }
      return res.data
    } catch (err) {
      if (err instanceof NewsletterServiceError && err.status === 404) {
        return null
      }
      throw err
    }
  }

  async updateNewsletter(
    id: number,
    data: Partial<
      Pick<Newsletter, 'subject' | 'status' | 'scheduled_at' | 'sent_at' | 'error'>
    >
  ): Promise<void> {
    if (data.status === 'scheduled') {
      // Lifecycle transition: POST .../schedule
      await this.leafFetch('POST', `/api/v1/newsletters/${id}/schedule`, {
        scheduled_at: data.scheduled_at,
      })
      return
    }
    if (data.status !== undefined) {
      // Other status transitions (sending/sent/failed/draft) are not exposed
      throw new NotSupportedViaServiceError(
        `updateNewsletter(status='${data.status}') — use dispatchNow for sends`
      )
    }
    // Non-status field update → PATCH (strip status field if somehow present)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { status: _status, ...patchData } = data
    await this.leafFetch('PATCH', `/api/v1/newsletters/${id}`, patchData)
  }

  // ── Recipients ────────────────────────────────────────────────────────────

  async setNewsletterRecipients(
    newsletterId: number,
    recipients: Array<{ mailing_list_id?: number; keycloak_group_id?: string }>
  ): Promise<void> {
    await this.leafFetch('PUT', `/api/v1/newsletters/${newsletterId}/recipients`, { recipients })
  }

  async getNewsletterRecipients(newsletterId: number): Promise<NewsletterRecipient[]> {
    const res = (await this.leafFetch(
      'GET',
      `/api/v1/newsletters/${newsletterId}/recipients`
    )) as { data: NewsletterRecipient[] }
    return res.data
  }

  // ── Aggregate counts ──────────────────────────────────────────────────────

  async countSubscribers(): Promise<number> {
    const res = (await this.leafFetch('GET', '/api/v1/stats')) as {
      data: { subscribers: number; newsletters: number }
    }
    return res.data.subscribers
  }

  async countNewsletterRecipients(newsletterId: number): Promise<number> {
    // No dedicated count endpoint; derive from the recipients list length.
    const recipients = await this.getNewsletterRecipients(newsletterId)
    return recipients.length
  }

  // ── Scheduler support — NOT exposed by service ────────────────────────────

  async getScheduledDueNewsletters(): Promise<Newsletter[]> {
    throw new NotSupportedViaServiceError('getScheduledDueNewsletters')
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async dispatchNow(
    newsletterId: number,
    _actorSub: string,
    _groupMemberFetcher: GroupMemberFetcher
  ): Promise<void> {
    // The leaf service owns dispatch internally. We trigger it via POST .../send.
    // actorSub and groupMemberFetcher are managed by the leaf; the kernel only
    // signals intent.
    await this.leafFetch('POST', `/api/v1/newsletters/${newsletterId}/send`, {})
  }

  // ── Delivery ledger — NOT exposed by service ──────────────────────────────

  async claimNewsletterForSending(_id: number): Promise<boolean> {
    throw new NotSupportedViaServiceError('claimNewsletterForSending')
  }

  async claimRecipient(_newsletterId: number, _email: string): Promise<ClaimResult> {
    throw new NotSupportedViaServiceError('claimRecipient')
  }

  async markSent(_newsletterId: number, _email: string, _messageId: string): Promise<void> {
    throw new NotSupportedViaServiceError('markSent')
  }

  async releaseDeliveryClaim(_newsletterId: number, _email: string): Promise<void> {
    throw new NotSupportedViaServiceError('releaseDeliveryClaim')
  }

  // ── Token / unsubscribe ───────────────────────────────────────────────────

  async addSendToken(_token: string, _newsletterId: number, _email: string): Promise<string> {
    throw new NotSupportedViaServiceError('addSendToken')
  }

  async consumeUnsubscribeToken(
    token: string
  ): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }> {
    // Protocol (F-LOW): an expired/invalid token is a SUCCESSFUL operation result
    // in the SQLite/port contract — NOT an HTTP error. The leaf POST /unsubscribe
    // returns HTTP 200 with {ok:false,reason:'expired'|'invalid'} for these cases
    // (see services/newsletter/src/http/routes.ts + store/tokens.ts), so the happy
    // path below just returns that body unchanged.
    //
    // Defensive alignment: should a leaf version instead signal expired/invalid
    // via HTTP 404/410 carrying a `reason`, map it back to {ok:false,reason} so
    // this method NEVER throws for the expired/invalid case — that would break
    // parity with the SQLite impl + the conformance contract. Any OTHER non-2xx
    // (5xx, auth, etc.) still propagates as a NewsletterServiceError.
    try {
      return (await this.leafFetch('POST', '/api/v1/unsubscribe', { token })) as
        | { ok: true }
        | { ok: false; reason: 'invalid' | 'expired' }
    } catch (err) {
      if (
        err instanceof NewsletterServiceError &&
        (err.status === 404 || err.status === 410)
      ) {
        // 404/410 with no usable reason → treat as 'invalid' (token gone).
        const reason = err.message.includes('expired') ? 'expired' : 'invalid'
        return { ok: false, reason }
      }
      throw err
    }
  }

  async addUnsubscribe(_email: string, _token: string): Promise<void> {
    throw new NotSupportedViaServiceError('addUnsubscribe')
  }

  async isUnsubscribed(_email: string): Promise<boolean> {
    throw new NotSupportedViaServiceError('isUnsubscribed')
  }

  async purgeSendTokensOlderThan90Days(): Promise<void> {
    throw new NotSupportedViaServiceError('purgeSendTokensOlderThan90Days')
  }

  // ── Audit ─────────────────────────────────────────────────────────────────

  async recordNewsletterAudit(
    newsletterId: number,
    actorSub: string,
    action: string
  ): Promise<void> {
    await this.leafFetch('POST', `/api/v1/newsletters/${newsletterId}/audit`, {
      actor_sub: actorSub,
      action,
    })
  }
}
