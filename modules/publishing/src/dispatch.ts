// services/newsletter/src/dispatch.ts
//
// Task 8: the send pipeline, service-side. Ports gremion-ui
// newsletter-sender.ts (buildRecipientList + dispatchNewsletter) to the leaf's
// per-tenant Postgres store + injected kernel client + injected SMTP transport.
//
// INTEGRATION-DELTA §1 (Option B2): the per-recipient send does NOT run a
// leaf-local SMTP transport. The injected MailTransport is, in production, a thin
// adapter over the kernel `POST /api/internal/newsletter/send-mail` callback —
// the kernel resolves the per-tenant SMTP transport (SP-2 sendMailForTenant,
// including per-tenant from-fields) and sends. SMTP credentials never leave the
// kernel; the leaf owns the deliveries ledger, the kernel owns the transport.
// A kernel-reported smtp-unconfigured surfaces as a per-recipient send FAILURE
// (newsletter → 'failed' + send.failed outbox), identical to a transport throw.
//
// dispatch(tenant, newsletterId, actor, deps):
//   1. claimNewsletterForSending — newsletter-LEVEL single-flight: a second
//      concurrent (or post-'sent') dispatch loses the claim and returns a no-op.
//      This is the FIRST of two duplicate-send gates.
//   2. kernel.render(odtPath) → HTML body.
//   3. recipient assembly (buildRecipientList semantics): own mailing lists from
//      PG + kernel.resolveGroup() per KC-group recipient; dedupe by lowercased
//      email; filter unsubscribed.
//   4. per recipient: claimRecipient (the SECOND, recipient-LEVEL gate — the
//      deliveries ledger) → only when 'fresh': addSendToken → transport.sendMail
//      → markSent. A per-recipient SMTP throw is isolated (try/catch), counted,
//      and the claim is LEFT in place (bounded at-least-once — see note below).
//   5. finish: in ONE tx, updateNewsletter(status sent|failed) co-committed with
//      enqueueOutbox('send.succeeded'|'send.failed') so the outbox row and the
//      status transition are atomic (no phantom/missed publish on crash).
//
// ── bounded at-least-once (DoD-c documentation) ───────────────────────────────
// The leaf's deliveries.ts (Task 6) deliberately exposes NO releaseDeliveryClaim
// (unlike the gremion-ui monolith): crash recovery is via the 15-min stale-claim
// takeover in claimRecipient. Consequences, by design:
//   - A crash AFTER transport.sendMail but BEFORE markSent leaves a 'claimed'
//     row. After 15 min a re-dispatch takes it over ('fresh') and RE-SENDS that
//     ONE recipient → at-least-once for the rare crash-in-the-gap case, bounded
//     to a single recipient, never the whole list.
//   - A per-recipient SMTP failure likewise leaves a 'claimed' row; the same
//     15-min window applies before retry. We do NOT release immediately, so a
//     hard-bouncing address is retried at most once per 15 min, not hammered.
//   - Already-'sent' rows are NEVER re-sent (claimRecipient → 'already-sent'),
//     and a non-stale 'claimed' row is skipped ('in-flight'), so concurrent and
//     fast sequential re-dispatch send EXACTLY ONCE per recipient.

import { randomUUID } from 'node:crypto'
import type { Sql, TenantRef } from './tenant-store.js'
import type { KernelClient, Recipient } from './kernel-client.js'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import {
  getNewsletter,
  getNewsletterRecipients,
  listMembers,
  updateNewsletter,
  addSendToken,
  isUnsubscribed,
  claimRecipient,
  markSent,
  claimNewsletterForSending,
  type NewsletterRecipient,
} from './store/index.js'
import { enqueueOutbox } from './outbox.js'

// ── injected transport ──────────────────────────────────────────────────────

/** What a successful send returns (the subset of the kernel send-mail reply we use). */
export interface SentMessage {
  messageId: string
}

/**
 * The narrow SMTP port dispatch depends on. Production wires a thin adapter that
 * delegates to the per-tenant kernel send-mail callback (INTEGRATION-DELTA §1
 * Option B2 — the leaf owns NO transport resolution); tests inject a fake.
 *
 * No `from` field: under Option B2 the KERNEL resolves the per-tenant from-fields
 * (SP-2 sendMailForTenant), so the leaf neither computes nor sends a from-address.
 */
export interface MailTransport {
  sendMail(msg: {
    to: string
    subject: string
    html: string
  }): Promise<SentMessage>
}

// ── dependencies ────────────────────────────────────────────────────────────

export interface DispatchDeps {
  /** Per-tenant postgres-js Sql (from storeFor(tenant)). */
  sql: Sql
  /** Kernel callback client (render + resolveGroup + sendMail). Tests inject a fake. */
  kernel: KernelClient
  /**
   * SMTP transport port. Production wires a thin adapter over the kernel
   * send-mail callback (Option B2 — no leaf-side SMTP); tests inject a fake.
   */
  transport: MailTransport
  /** This tenant's external origin for unsubscribe links (no trailing slash). */
  origin: string
  /**
   * Whether a LOOPBACK origin is acceptable for this dispatch.
   *
   * PASSED IN, not read from the environment here: index.ts already resolves
   * NEWSLETTER_ALLOW_LOOPBACK_LINKS once at boot, and a second env read beside
   * that resolver is exactly the duplicated fallback the link base already got
   * burned by. Defaults to false, so a caller that says nothing gets the strict
   * production behaviour.
   */
  allowLoopbackLinks?: boolean
  /**
   * T16 (P1 correlation-id): the correlation id for this dispatch.
   * Injected by the HTTP send-route from the inbound x-correlation-id header
   * (read-or-minted by the kernel, forwarded via KernelClientOptions.correlationId).
   * Falls back to String(newsletterId) when absent (preserves existing behaviour).
   */
  correlationId?: string
  /**
   * T16 (D-P1-8): optional TracerPort for span emission.
   * Production wires makeLogTracer(correlationId) when TRACE_EXPORTER=log.
   * Defaults to noopTracer so existing tests need no change.
   */
  tracer?: TracerPort
}

type RecipientRef = Pick<NewsletterRecipient, 'mailing_list_id' | 'keycloak_group_id'>

// ── recipient assembly (port of gremion-ui buildRecipientList) ──────────────────

/**
 * Build the deduplicated, unsubscribe-filtered recipient list.
 * Own mailing lists are read from PG; Keycloak groups are resolved via the
 * injected kernel client. Dedupe key is the lowercased email; the FIRST
 * occurrence's name wins (matches the gremion-ui port exactly).
 */
export async function buildRecipientList(
  sql: Sql,
  recipients: RecipientRef[],
  kernel: KernelClient,
): Promise<Recipient[]> {
  const seen = new Set<string>()
  const result: Recipient[] = []

  for (const r of recipients) {
    let batch: Recipient[] = []
    if (r.mailing_list_id !== null) {
      const members = await listMembers(sql, r.mailing_list_id)
      batch = members.map((m) => ({ email: m.email, name: m.name }))
    } else if (r.keycloak_group_id !== null) {
      batch = await kernel.resolveGroup(r.keycloak_group_id)
    }

    for (const { email, name } of batch) {
      const lower = email.toLowerCase()
      if (seen.has(lower)) continue
      if (await isUnsubscribed(sql, lower)) continue
      seen.add(lower)
      result.push({ email: lower, name })
    }
  }

  return result
}

/**
 * ORIGIN is the public root every link in a rendered newsletter is built from,
 * including the UNSUBSCRIBE link — which is not optional (GDPR/CAN-SPAM).
 *
 * FAIL CLOSED. An unset or relative origin makes `${origin}/newsletter/...`
 * collapse to the host-relative string `/newsletter/unsubscribe?token=…`, which
 * a mail client resolves against ITS OWN host (https://mail.google.com/...): the
 * link looks live, lands on the wrong host, and can trip phishing heuristics.
 * That is strictly worse than the old `http://localhost:3000` default, which at
 * least failed visibly. Neither is acceptable on the one surface in this service
 * that leaves the machine and reaches real recipients, so both the boot path
 * (src/index.ts) and every dispatch/relay pass refuse rather than mail it.
 *
 * @param raw     the candidate origin (process.env.ORIGIN, or deps.origin).
 * @param context what is being refused, named in the error (tenant/newsletter).
 * @returns the origin with any trailing slashes removed.
 */
export function requireAbsoluteOrigin(
  raw: string | undefined,
  context: string,
  varNames = 'ORIGIN',
): string {
  const candidate = raw ?? ''
  let parsed: URL | null = null
  // Whitespace is REJECTED, not trimmed. A trimmed value hides the
  // misconfiguration that produced it, and a newline in a string that ends up
  // in a mail header is an injection primitive.
  if (!/\s/.test(candidate)) {
    try {
      parsed = new URL(candidate.replace(/\/+$/, ''))
    } catch {
      parsed = null
    }
  }
  const acceptable =
    parsed !== null &&
    (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
    // Userinfo in a link base mails credentials to every subscriber, and
    // https://real.example.org@attacker.test is a stock phishing shape.
    parsed.username === '' &&
    parsed.password === '' &&
    // A path/query/fragment here is silently concatenated with the route below
    // it, producing links like https://host/app/newsletter/unsubscribe?…?token=…
    (parsed.pathname === '' || parsed.pathname === '/') &&
    parsed.search === '' &&
    parsed.hash === ''
  if (!acceptable || parsed === null) {
    throw new Error(
      `[newsletter] ${varNames} must be an absolute http(s) URL with no userinfo, path, ` +
        `query, fragment or whitespace — refusing ${context}. ` +
        `Got ${JSON.stringify(raw ?? '')}. Every dispatched newsletter carries an unsubscribe ` +
        `link built from it; a missing or relative one mails ` +
        `"/newsletter/unsubscribe?token=…", which resolves against the RECIPIENT'S mail host. ` +
        `Set ${varNames} to this deployment's public base URL (e.g. https://<host>).`,
    )
  }
  // The NORMALISED origin, not the raw string: scheme and host are lowercased
  // and the default port is dropped, so two deployments that differ only in
  // spelling build the same unsubscribe URL.
  return parsed.origin
}

// ── link-base USABILITY (T05R5) ─────────────────────────────────────────────
//
// requireAbsoluteOrigin above is a SHAPE guard: it proves the string parses as
// an absolute http(s) URL with nothing dangerous hanging off it. Round 4 stopped
// there, and `http://localhost:3000` passes every one of those checks.
//
// That is not a hypothetical value. It is the value this repo PROVISIONS:
// docker-compose.yml's newsletter-service block and k8s/base/newsletter/
// configmap.yaml both set PUBLIC_BASE_URL=http://localhost:3000, so the
// unconfigured path is the DEPLOYED path and round 4's guard opened the gate on
// exactly it. Every unsubscribe link in every dispatched newsletter then reads
// `http://localhost:3000/newsletter/unsubscribe?token=…`, which in a
// subscriber's mail client resolves to THEIR machine — a dead link on an
// obligation that carries legal weight (GDPR/CAN-SPAM).
//
// Three host classes are unmailable for the same reason and are refused here:
//   - LOOPBACK      localhost, *.localhost, 127.0.0.0/8, ::1
//   - UNSPECIFIED   0.0.0.0, ::            (a bind address, never a destination)
//   - LINK-LOCAL    169.254.0.0/16, fe80::/10
// A private LAN address (10.x, 192.168.x) is NOT refused: it is genuinely
// reachable from a mail client on the same network, and refusing it would break
// on-prem deployments this leaf is meant to support.

/** Why a link base cannot be used to build subscriber-facing links. */
export type LinkBaseFault = 'missing' | 'malformed' | 'loopback' | 'unspecified' | 'link-local'

/** Which environment variable supplied the link base. */
export type LinkBaseSource = 'ORIGIN' | 'PUBLIC_BASE_URL'

/**
 * Env flag that unlocks LOOPBACK link bases. Development and CI only: it exists
 * so `pnpm dev` against a local stack is not blocked by a guard aimed at
 * production mail, and it unlocks LOOPBACK ONLY — an unspecified or link-local
 * base is wrong everywhere, including on a laptop.
 */
export const ALLOW_LOOPBACK_LINKS_VAR = 'NEWSLETTER_ALLOW_LOOPBACK_LINKS'

/**
 * Thrown when the link base parses but cannot be mailed.
 *
 * A distinct type, not a bare Error: the send route has to be able to tell a
 * misconfigured deployment (operator fixes an env var) from a transport failure
 * (retry), and `instanceof` is the only honest way to do that.
 */
export class LinkBaseUnusableError extends Error {
  readonly code = 'LINK_BASE_UNUSABLE'
  readonly fault: LinkBaseFault
  constructor(message: string, fault: LinkBaseFault) {
    super(message)
    this.name = 'LinkBaseUnusableError'
    this.fault = fault
  }
}

/**
 * Classify a URL hostname into one of the unmailable classes, or null when it
 * is a host a subscriber's mail client could actually reach.
 *
 * Takes the hostname as `URL.hostname` produces it — already lowercased, with
 * IPv6 literals still in their square brackets.
 */
export function classifyLinkHost(
  hostname: string,
): 'loopback' | 'unspecified' | 'link-local' | null {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  // RFC 6761: `localhost` and anything under it resolve to the loopback.
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback'
  // The WHOLE 127.0.0.0/8 block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return 'loopback'
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'loopback'
  if (h === '0.0.0.0') return 'unspecified'
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return 'unspecified'
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return 'link-local'
  // fe80::/10 — fe80 through febf. The first hextet cannot be written shorter
  // than four characters in that range, so an exact 4-char match is complete.
  if (/^fe[89ab][0-9a-f]:/.test(h)) return 'link-local'
  return null
}

export interface LinkBaseCheckOptions {
  /** Permit a LOOPBACK base (the dev override). Never permits the other two. */
  readonly allowLoopback?: boolean
  /** How to name the source variable(s) in the error message. */
  readonly varNames?: string
}

/**
 * The full gate: shape (requireAbsoluteOrigin) THEN reachability. Returns the
 * normalised origin, or throws LinkBaseUnusableError naming the fault.
 */
export function requireUsableLinkBase(
  raw: string | undefined,
  context: string,
  options: LinkBaseCheckOptions = {},
): string {
  const varNames = options.varNames ?? 'ORIGIN'
  let origin: string
  try {
    origin = requireAbsoluteOrigin(raw, context, varNames)
  } catch (err) {
    throw new LinkBaseUnusableError(
      err instanceof Error ? err.message : String(err),
      raw === undefined || raw === '' ? 'missing' : 'malformed',
    )
  }
  const fault = classifyLinkHost(new URL(origin).hostname)
  if (fault === null) return origin
  if (fault === 'loopback' && options.allowLoopback === true) return origin
  throw new LinkBaseUnusableError(
    `[newsletter] ${varNames} resolves to a ${fault} host — refusing ${context}. ` +
      `Got ${JSON.stringify(raw ?? '')}. Every dispatched newsletter carries an unsubscribe ` +
      `link built from it, and a ${fault} address is meaningless in a subscriber's mail ` +
      `client: it resolves to THEIR machine, not to this deployment. Set ${varNames} to this ` +
      `deployment's PUBLIC base URL (e.g. https://sturaos.com).` +
      (fault === 'loopback'
        ? ` For local development ONLY, ${ALLOW_LOOPBACK_LINKS_VAR}=1 unlocks loopback bases.`
        : ''),
    fault,
  )
}

/** The subset of the process environment the link base is resolved from. */
export interface LinkBaseEnv {
  readonly ORIGIN?: string | undefined
  readonly PUBLIC_BASE_URL?: string | undefined
  readonly NEWSLETTER_ALLOW_LOOPBACK_LINKS?: string | undefined
}

/** The outcome of resolving the link base at boot. */
export type LinkBaseResolution =
  | {
      readonly usable: true
      readonly base: string
      readonly source: LinkBaseSource
      /** True when a LOOPBACK base was let through by the dev override. */
      readonly loopbackOverride: boolean
      readonly raw: string
    }
  | {
      readonly usable: false
      readonly base: null
      readonly source: LinkBaseSource | null
      readonly fault: LinkBaseFault
      /** The full operator-facing explanation, ready to log verbatim. */
      readonly reason: string
      readonly raw: string
    }

/** Is the loopback dev override switched on? */
export function loopbackLinksAllowed(env: LinkBaseEnv): boolean {
  const v = env.NEWSLETTER_ALLOW_LOOPBACK_LINKS
  return v === '1' || v?.toLowerCase() === 'true'
}

/**
 * Resolve the public root every link in a rendered newsletter is built from.
 *
 * ORIGIN wins when it is set, PUBLIC_BASE_URL is the fallback, and the RESULT
 * RECORDS WHICH ONE WON — an operator staring at a wrong link needs to know
 * which of two variables produced it.
 *
 * WHY THE FALLBACK: ORIGIN is provisioned NOWHERE. Not in the newsletter-service
 * block of docker-compose.yml, not in docker-compose.prod/override/smoke, not in
 * k8s/base/newsletter/configmap.yaml, not in .env.example. Requiring ORIGIN
 * alone turned the guard into a guaranteed crash-loop on the next deploy
 * (`restart: unless-stopped`). PUBLIC_BASE_URL *is* provisioned in both compose
 * and the k8s configmap — the configmap comment calling it "inert for tenancy"
 * is about TENANT SELECTION (this leaf resolves tenants from x-tenant-id, never
 * from a host), which is a different concern from building an absolute link.
 *
 * NEVER THROWS. Round 4 failed the boot closed, which sounds strict and is in
 * fact the same crash-loop: both provisioned values are `http://localhost:3000`,
 * so a throwing resolver takes down the ENTIRE newsletter surface — including
 * every route that sends no mail at all — over a defect that only affects
 * sending. The refusal belongs at dispatch(), which is the only operation the
 * bad value actually corrupts. The caller logs this resolution and boots.
 */
export function resolveLinkBase(env: LinkBaseEnv, context: string): LinkBaseResolution {
  // `??` and not `||`: an explicitly-set-but-empty ORIGIN is a misconfiguration
  // to report on, not a hole to fall through.
  const raw = env.ORIGIN ?? env.PUBLIC_BASE_URL
  const source: LinkBaseSource | null =
    env.ORIGIN !== undefined
      ? 'ORIGIN'
      : env.PUBLIC_BASE_URL !== undefined
        ? 'PUBLIC_BASE_URL'
        : null
  const allowLoopback = loopbackLinksAllowed(env)
  try {
    const base = requireUsableLinkBase(raw, context, {
      allowLoopback,
      varNames: 'ORIGIN (or PUBLIC_BASE_URL)',
    })
    return {
      usable: true,
      base,
      // Unreachable with source === null: a missing raw throws above.
      source: source ?? 'PUBLIC_BASE_URL',
      loopbackOverride: allowLoopback && classifyLinkHost(new URL(base).hostname) === 'loopback',
      raw: raw ?? '',
    }
  } catch (err) {
    return {
      usable: false,
      base: null,
      source,
      fault: err instanceof LinkBaseUnusableError ? err.fault : 'malformed',
      reason: err instanceof Error ? err.message : String(err),
      raw: raw ?? '',
    }
  }
}

/** The three log channels the boot report uses. Injected so it can be asserted. */
export interface LinkBaseLogger {
  error: (msg: string) => void
  warn: (msg: string) => void
  info: (msg: string) => void
}

/**
 * Report a link-base resolution at boot: EXACTLY ONE line, on the channel that
 * matches what happened.
 *
 * A function rather than three console calls inlined in index.ts, because
 * "logs one error naming both variables and the value" is only assertable when
 * the logging is a seam.
 */
export function logLinkBaseResolution(res: LinkBaseResolution, log: LinkBaseLogger): void {
  if (!res.usable) {
    log.error(res.reason)
    return
  }
  if (res.loopbackOverride) {
    log.warn(
      `[newsletter] link base ${res.base} is a LOOPBACK address, accepted only because ` +
        `${ALLOW_LOOPBACK_LINKS_VAR} is set (source: ${res.source}). Newsletters sent from this ` +
        `process carry unsubscribe links no subscriber can open — development only.`,
    )
    return
  }
  log.info(`[newsletter] link base ${res.base} (source: ${res.source})`)
}

/** Insert the unsubscribe footer before </body> (port of gremion-ui helper). */
export function injectUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
  const footer =
    `<p style="font-size:12px;color:#888;">` + `<a href="${unsubscribeUrl}">Abmelden</a></p>`
  const idx = html.lastIndexOf('</body>')
  if (idx === -1) return html + footer
  return html.slice(0, idx) + footer + html.slice(idx)
}

// ── dispatch ──────────────────────────────────────────────────────────────────

/**
 * Dispatch one newsletter. See the module header for the full contract.
 *
 * @param tenant       tenant identity (used for correlation/logging).
 * @param newsletterId the newsletter to send.
 * @param actor        the sub responsible for the send (audit + outbox payload).
 * @param deps         injected sql / kernel / transport / origin.
 */
export async function dispatch(
  tenant: TenantRef,
  newsletterId: number,
  actor: string,
  deps: DispatchDeps,
): Promise<void> {
  const { sql, kernel, transport } = deps
  // Fail closed BEFORE anything is claimed or rendered: a send with a relative
  // origin would mail an unresolvable unsubscribe link to every recipient, and
  // the pre-T05R3 code did exactly that with no signal beyond one boot warn.
  let origin: string
  try {
    origin = requireUsableLinkBase(
      deps.origin,
      `newsletter #${newsletterId} (tenant ${tenant.slug})`,
      { allowLoopback: deps.allowLoopbackLinks === true },
    )
  } catch (err) {
    console.error(
      `[dispatch] REFUSING to send newsletter #${newsletterId} (tenant ${tenant.slug}): ` +
        (err instanceof Error ? err.message : String(err)),
    )
    throw err
  }
  // T16: use injected correlationId (real UUID from the HTTP caller) or fall
  // back to String(newsletterId) to preserve the existing default behaviour.
  const correlationId = deps.correlationId ?? String(newsletterId)
  const tracer = deps.tracer ?? noopTracer
  const span = tracer.startSpan('newsletter.dispatch', { newsletterId, tenant: tenant.slug })

  // 1. Newsletter-level claim (FIRST duplicate-send gate). If we lose it the
  //    newsletter is already 'sending' or 'sent' — another dispatch owns it (or
  //    it is finished). Return a no-op; this is what makes a concurrent OR fast
  //    sequential second dispatch send nothing.
  const claimed = await claimNewsletterForSending(sql, newsletterId)
  if (!claimed) {
    console.info(
      `[dispatch] newsletter #${newsletterId} (tenant ${tenant.slug}) not claimable ` +
        `(already sending/sent) — skipping`,
    )
    span.end()
    return
  }

  let recipientCount = 0
  try {
    const newsletter = await getNewsletter(sql, newsletterId)
    if (!newsletter) throw new Error(`newsletter ${newsletterId} not found`)

    // 2. Render the body via the kernel callback.
    const html = await kernel.render(newsletter.odt_path)

    // 3. Assemble the recipient list (dedupe + unsubscribe filter).
    const recipientRows = await getNewsletterRecipients(sql, newsletterId)
    const recipients = await buildRecipientList(sql, recipientRows, kernel)
    recipientCount = recipients.length

    // 4. Per-recipient claim → send → mark-sent. Each send is isolated so one
    //    recipient's SMTP failure never aborts the loop or re-sends the others.
    let delivered = 0
    let failed = 0
    let lastError: unknown
    for (const { email } of recipients) {
      const claim = await claimRecipient(sql, newsletterId, email)
      if (claim !== 'fresh') continue // already-sent or in-flight → skip (the gate)

      // addSendToken returns the EFFECTIVE persisted token: on a retry/takeover
      // the original token is kept so the unsubscribe link in the email is live.
      const token = await addSendToken(sql, randomUUID(), newsletterId, email)
      const unsubUrl = `${origin}/newsletter/unsubscribe?token=${token}`
      const personalizedHtml = injectUnsubscribeFooter(html, unsubUrl)

      try {
        // No `from` — the kernel resolves per-tenant from-fields (Option B2).
        const info = await transport.sendMail({
          to: email,
          subject: newsletter.subject,
          html: personalizedHtml,
        })
        await markSent(sql, newsletterId, email, String(info.messageId))
        delivered += 1
      } catch (err) {
        // Leave the claim in place (bounded at-least-once — see module header).
        failed += 1
        lastError = err
        console.error(
          `[dispatch] send to ${email} (newsletter #${newsletterId}) failed:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    if (failed > 0) {
      const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
      throw new Error(`${failed} recipient(s) failed to send${detail}`)
    }

    // 5a. SUCCESS finish: status 'sent' + send.succeeded outbox in ONE tx.
    await finish(sql, newsletterId, correlationId, {
      ok: true,
      payload: { newsletterId, recipientCount, deliveredCount: delivered, actor },
    })
    span.end()
  } catch (err) {
    // 5b. FAILURE finish: status 'failed' + send.failed outbox in ONE tx.
    const message = err instanceof Error ? err.message : 'Unknown error'
    await finish(sql, newsletterId, correlationId, {
      ok: false,
      error: message,
      payload: { newsletterId, recipientCount, error: message, actor },
    })
    span.end(err)
    throw err
  }
}

// ── transactional finish ──────────────────────────────────────────────────────

/**
 * Co-commit the newsletter status transition with its outbox row.
 *
 * The status UPDATE and the outbox INSERT happen in the SAME postgres-js
 * transaction so an interrupted finish never leaves a 'sent' newsletter without
 * its send.succeeded row (or vice versa) — the atomic-publish guarantee the
 * outbox depends on (P0.3a / D-P1-7).
 */
async function finish(
  sql: Sql,
  newsletterId: number,
  correlationId: string,
  outcome:
    | { ok: true; payload: unknown }
    | { ok: false; error: string; payload: unknown },
): Promise<void> {
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as Sql
    if (outcome.ok) {
      await updateNewsletter(txSql, newsletterId, {
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
      await enqueueOutbox(txSql, 'send.succeeded', outcome.payload, correlationId)
    } else {
      await updateNewsletter(txSql, newsletterId, {
        status: 'failed',
        error: outcome.error,
      })
      await enqueueOutbox(txSql, 'send.failed', outcome.payload, correlationId)
    }
  })
}
