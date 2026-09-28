// services/newsletter/src/kernel-client.ts
//
// Task 8: callback HTTP client FROM the newsletter leaf TO the kernel (gremion-ui).
//
// The leaf owns the send pipeline (dispatch.ts) but three privileged operations
// still live in the kernel and are reached over HTTP at send time:
//   1. render(odtPath)        → the rendered newsletter HTML (kernel pulls the
//                               .odt from Nextcloud + converts via Collabora —
//                               the leaf never touches Nextcloud/Collabora).
//   2. resolveGroup(groupId)  → the members of a Keycloak group (the kernel is
//                               the only side with KC-admin credentials).
//   3. sendMail(msg)          → send ONE rendered email through the per-tenant
//                               SMTP transport (SP-2 §2.2a sendMailForTenant via
//                               POST /api/internal/newsletter/send-mail). The
//                               INTEGRATION-DELTA §1 Option B2 decision: SMTP
//                               credentials NEVER leave the kernel, so the leaf
//                               owns ZERO transport resolution. The kernel
//                               resolves per-tenant from-fields itself, so the
//                               leaf does NOT send `from`.
//
// EVERY request forwards:
//   - x-internal-auth : the shared INTERNAL_NEWSLETTER_SECRET (same secret the
//                       leaf's own guard.ts validates on inbound calls — the
//                       kernel callback endpoints validate the same secret).
//   - x-tenant-id / x-tenant-slug : so the kernel resolves the SAME tenant the
//                       leaf is dispatching for (the kernel callback runs the
//                       render/KC-admin lookup in that tenant's scope).
//   - x-correlation-id : the dispatch correlation id (the newsletter id) so a
//                       send is traceable end-to-end across the two processes.
//
// HOW THE KERNEL PICKS THE TENANT (Tenancy D1 HARDENING-3). The kernel's tenant
// resolver (gremion-ui/src/lib/server/tenant/resolve.ts) is sequence() element 0
// and runs BEFORE every callback handler, so a callback has to satisfy it before
// the x-internal-auth guard above is even reached. It selects THIS callback's
// tenant from the `x-tenant-id` the leaf already sends, having authenticated the
// assertion with the very `x-internal-auth` secret the destination route
// validates for itself (gremion-ui/src/lib/server/tenant/leaf-trust.ts). So the
// four headers above are the whole contract: nothing host-shaped is sent, and
// this leaf holds no hostname for any tenant.
//
// ⛔ DO NOT reintroduce a host here. Two earlier shapes were tried and both are
// deleted on purpose:
//   * `<slug>.<apexDomain>`, synthesised from PUBLIC_BASE_URL. The kernel now
//     looks the WHOLE host up in `tenant_domain`, so that string selects the
//     tenant only by coincidence: on a tenant-owned domain it resolves NOTHING,
//     and if another tenant registered `<this-slug>.<apex>` it resolves THAT
//     tenant — a silent, fail-OPEN, cross-tenant write.
//   * the tenant's registered host, threaded down as `x-tenant-host` and cached
//     in `tenant_catalog.primary_host`. Correct, but it made this leaf hold a
//     replica of a control-plane fact with no backfill: the SCHEDULER and relay
//     loops have no inbound request to read it from, so every scheduled send
//     between a deploy and the first kernel-driven request for that tenant
//     failed closed — and the replica went stale whenever an operator moved a
//     host, which needed a whole second mechanism to stay merely loud.
// The tenant id was always the thing being communicated; the host was a lossy
// re-encoding of it that this process had to be told and then remember.
//
// The transport is injectable (`fetchImpl`) so tests exercise header forwarding
// and error handling against a FAKE fetch — no live kernel is ever required.

import type { TenantRef } from './tenant-store.js'

/** A resolved recipient (mirrors gremion-ui newsletter-sender Recipient). */
export interface Recipient {
  email: string
  name: string | null
}

/** The fully-rendered, per-recipient message the leaf POSTs to the kernel
 *  send-mail callback. No `from` — the kernel resolves per-tenant from-fields. */
export interface OutgoingMail {
  to: string
  subject: string
  html: string
}

/** What a successful kernel send-mail returns (the kernel's SMTP message id). */
export interface SentMail {
  messageId: string
}

/**
 * Thrown by KernelClient.sendMail when the kernel reports the tenant's SMTP is
 * not configured (the send-mail endpoint's 503 {success:false,error:
 * 'smtp-unconfigured'} body — SP-2 SmtpUnconfiguredError). dispatch.ts treats
 * this as a per-recipient SEND FAILURE (counted, claim left in place → the
 * newsletter goes 'failed' + a send.failed outbox row), NOT a crash and NOT a
 * retryable infra error: configuration won't fix itself by retrying.
 */
export class MailUnconfiguredError extends Error {
  constructor(message = 'kernel send-mail: tenant SMTP not configured') {
    super(message)
    this.name = 'MailUnconfiguredError'
  }
}

/**
 * The narrow port the dispatch engine depends on. dispatch.ts is written
 * against THIS interface, never the concrete HTTP client, so tests inject a
 * fake (an object with render + resolveGroup + sendMail) and the real client is
 * only wired in production / at the process boundary.
 */
export interface KernelClient {
  /** Render the newsletter body (kernel: Nextcloud download → Collabora → HTML). */
  render(odtPath: string): Promise<string>
  /** Resolve a Keycloak group id to its email-bearing members. */
  resolveGroup(groupId: string): Promise<Recipient[]>
  /**
   * Send one rendered email via the kernel's per-tenant SMTP transport (SP-2
   * Option B2). Resolves to {messageId} on success. Throws MailUnconfiguredError
   * when the tenant's SMTP is unconfigured (503); throws a generic Error on any
   * other non-ok status (retryable infra failure).
   */
  sendMail(msg: OutgoingMail): Promise<SentMail>
}

/** Minimal fetch shape so we can inject a fake without pulling in DOM libs. */
export type FetchLike = (
  input: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  json(): Promise<unknown>
}>

export interface KernelClientOptions {
  /** Base URL of the kernel internal callback API (no trailing slash needed). */
  baseUrl: string
  /** Shared internal secret — forwarded as x-internal-auth. */
  secret: string
  /** The tenant this client is bound to (forwarded as x-tenant-id / -slug). */
  tenant: TenantRef
  /** The correlation id for this dispatch (forwarded as x-correlation-id). */
  correlationId: string
  /** Injectable transport (defaults to global fetch). */
  fetchImpl?: FetchLike
}

/**
 * Build the per-request headers. Centralised so render() and resolveGroup()
 * forward an IDENTICAL header set (the kernel guard rejects any request missing
 * the secret or tenant headers — see guard.ts for the inbound mirror).
 */
function buildHeaders(opts: KernelClientOptions): Record<string, string> {
  // Tenancy D1 HARDENING-3: this is the COMPLETE set. `x-tenant-id` is both the
  // identity the callback handler acts on and the tenant the kernel's element-0
  // resolver selects; `x-internal-auth` is what authenticates that assertion at
  // both. There is deliberately no `x-forwarded-host` and no `x-proxy-trust` —
  // see the ⛔ block at the top of this file before adding either back.
  return {
    'content-type': 'application/json',
    'x-internal-auth': opts.secret,
    'x-tenant-id': opts.tenant.id,
    'x-tenant-slug': opts.tenant.slug,
    'x-correlation-id': opts.correlationId,
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * Construct a KernelClient bound to one tenant + one dispatch correlation id.
 * The returned object satisfies the KernelClient port the dispatch engine
 * depends on.
 */
export function createKernelClient(opts: KernelClientOptions): KernelClient {
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const base = trimBase(opts.baseUrl)
  const headers = buildHeaders(opts)

  return {
    async render(odtPath: string): Promise<string> {
      const res = await fetchImpl(`${base}/api/internal/newsletter/render`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ odtPath }),
      })
      if (!res.ok) {
        const snippet = await res.text().catch(() => '')
        throw new Error(`kernel render failed: ${res.status} ${snippet.slice(0, 200)}`)
      }
      const data = (await res.json()) as { html?: unknown }
      if (typeof data.html !== 'string') {
        throw new Error('kernel render returned no html')
      }
      return data.html
    },

    async resolveGroup(groupId: string): Promise<Recipient[]> {
      const res = await fetchImpl(`${base}/api/internal/newsletter/resolve-group`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ groupId }),
      })
      if (!res.ok) {
        const snippet = await res.text().catch(() => '')
        throw new Error(`kernel resolve-group failed: ${res.status} ${snippet.slice(0, 200)}`)
      }
      const data = (await res.json()) as { members?: unknown }
      if (!Array.isArray(data.members)) {
        throw new Error('kernel resolve-group returned no members array')
      }
      return data.members
        .map((m): Recipient | null => {
          if (m === null || typeof m !== 'object') return null
          const email = (m as Record<string, unknown>)['email']
          if (typeof email !== 'string' || email.length === 0) return null
          const name = (m as Record<string, unknown>)['name']
          return { email, name: typeof name === 'string' ? name : null }
        })
        .filter((r): r is Recipient => r !== null)
    },

    async sendMail(msg: OutgoingMail): Promise<SentMail> {
      const res = await fetchImpl(`${base}/api/internal/newsletter/send-mail`, {
        method: 'POST',
        headers,
        // No `from` — the kernel resolves the per-tenant from-fields (SP-2).
        body: JSON.stringify({ to: msg.to, subject: msg.subject, html: msg.html }),
      })
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { messageId?: unknown }
        // messageId may be absent (a transport that returns none) — tolerate it.
        return { messageId: typeof data.messageId === 'string' ? data.messageId : '' }
      }
      // 503 smtp-unconfigured → a TYPED send failure (NOT retryable, NOT a crash).
      // The endpoint returns {success:false,error:'smtp-unconfigured'} on a
      // tenant whose SMTP is not set up (SP-2 SmtpUnconfiguredError).
      if (res.status === 503) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown }
        if (body.error === 'smtp-unconfigured') {
          throw new MailUnconfiguredError(
            `kernel send-mail: tenant SMTP not configured (to=${msg.to})`,
          )
        }
      }
      // Any other non-ok (400/401/500/…) is a retryable infra failure → throw a
      // generic Error so dispatch leaves the claim in place for the stale-takeover.
      const snippet = await res.text().catch(() => '')
      throw new Error(`kernel send-mail failed: ${res.status} ${snippet.slice(0, 200)}`)
    },
  }
}
