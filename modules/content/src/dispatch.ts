// services/content/src/dispatch.ts
//
// Task 18: three-channel publish pipeline for the content leaf.
//
// Mirrors services/newsletter/src/dispatch.ts, adapted for:
//  - Three channels (email, portal, instagram) via an injected Map<channel, ChannelTransport>.
//  - Email → per-recipient claim gate → kernel.sendMail-backed transport (Option B2).
//  - Portal → kernel.portalPublish once per post → createPublication(postId,'portal',news_posts_id).
//  - Instagram → createPublishOp(postId,'instagram','publish') (drained by scheduler).
//  - claimPostForPublish makes a second dispatch a no-op (post-level single-flight gate).
//  - Each finished channel co-commits its status update AND its outbox event in ONE tx.
//
// Channel semantics:
//   email:     Same bounded at-least-once pattern as newsletter — per-recipient
//              claim → send → markSent/markFailed. Stale-claim takeover at 15 min.
//   portal:    Single network call to the kernel. Idempotent at the kernel side
//              (content_origin_post_id UNIQUE). Failure rolls the entire dispatch to 'failed'.
//   instagram: Purely outbox — createPublishOp enqueues a 'pending' row drained by
//              the scheduler. Never blocks the dispatch.
//
// Outbox events emitted (ContentEvent):
//   'publish.succeeded'           — overall success (all channels completed).
//   'publish.failed'              — overall failure.
//   'channel.email.sent'          — email channel completed.
//   'channel.portal.sent'         — portal channel completed.
//   'channel.instagram.enqueued'  — instagram publish_op enqueued.

import { randomUUID } from 'node:crypto'
import type { Sql, TenantRef } from './tenant-store.js'
import type { KernelClient, Recipient } from './kernel-client.js'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import {
  claimPostForPublish,
  updatePost,
  getPost,
  getPostChannelRecipients,
  listMembers,
  isUnsubscribed,
  addSendToken,
  claimRecipient,
  markSent,
  markFailed,
  createPublication,
  createPublishOp,
} from './store/index.js'
import { enqueueOutbox } from './outbox.js'

// ── injected transport ──────────────────────────────────────────────────────

/**
 * A generic channel transport port. For email the `send` payload is
 * { to, subject, html }; portal and instagram channels wire no-op (the
 * real work goes through kernel.portalPublish or createPublishOp).
 *
 * The Map presence signals the channel is active — a missing key means the
 * channel is skipped.
 */
export interface ChannelTransport {
  send(msg: { to?: string; subject?: string; html?: string }): Promise<{ id: string }>
}

// ── dependencies ────────────────────────────────────────────────────────────

export interface DispatchDeps {
  /** Per-tenant postgres-js Sql (from storeFor(tenant)). */
  sql: Sql
  /** Kernel callback client (resolveGroup + sendMail + portalPublish). Tests inject a fake. */
  kernel: KernelClient
  /**
   * Active channels. The Map presence of a key means that channel is enabled.
   * Email transport is used for per-recipient sends (Option B2: thin adapter
   * over kernel.sendMail). Portal and instagram transports are no-op placeholders —
   * the real work goes through kernel.portalPublish or createPublishOp.
   */
  channels: Map<'email' | 'portal' | 'instagram', ChannelTransport>
  /** This tenant's external origin for unsubscribe links (no trailing slash). */
  origin: string
  /**
   * The correlation id for this dispatch. Injected by the HTTP send-route from
   * the inbound x-correlation-id header. Falls back to the postId when absent.
   */
  correlationId?: string
  /**
   * Optional TracerPort for span emission. Defaults to noopTracer.
   */
  tracer?: TracerPort
}

type RecipientRef = { mailing_list_id: string | null; keycloak_group_id: string | null }

// ── recipient assembly ─────────────────────────────────────────────────────────

/**
 * Build the deduplicated, unsubscribe-filtered recipient list for the email channel.
 * Own mailing lists are read from PG; Keycloak groups via kernel.resolveGroup.
 * Dedupe key is the lowercased email; FIRST occurrence's name wins.
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
 * Dispatch one content post across all enabled channels.
 *
 * @param tenant   Tenant identity (id + slug).
 * @param postId   The content post UUID to publish.
 * @param actor    The sub responsible for the publish (audit + outbox payload).
 * @param deps     Injected sql / kernel / channels / origin.
 */
export async function dispatch(
  tenant: TenantRef,
  postId: string,
  actor: string,
  deps: DispatchDeps,
): Promise<void> {
  const { sql, kernel, channels, origin } = deps
  const correlationId = deps.correlationId ?? postId
  const tracer = deps.tracer ?? noopTracer
  const span = tracer.startSpan('content.dispatch', { postId, tenant: tenant.slug })

  // 1. Post-level claim (FIRST duplicate-send gate). If we lose it the post is
  //    already 'sending' or 'sent' — another dispatch owns it (or it is finished).
  //    Return a no-op; this is what makes a concurrent OR fast sequential second
  //    dispatch publish nothing.
  const claimed = await claimPostForPublish(sql, postId)
  if (!claimed) {
    console.info(
      `[dispatch] post ${postId} (tenant ${tenant.slug}) not claimable ` +
        `(already sending/sent) — skipping`,
    )
    span.end()
    return
  }

  const channelEvents: Array<{ event: 'channel.email.sent' | 'channel.portal.sent' | 'channel.instagram.enqueued'; payload: unknown }> = []

  try {
    const post = await getPost(sql, postId)
    if (!post) throw new Error(`content post ${postId} not found`)

    // ── Email channel ────────────────────────────────────────────────────────
    if (channels.has('email')) {
      const emailTransport = channels.get('email')!
      await dispatchEmail(sql, kernel, emailTransport, postId, post, origin, correlationId, channelEvents)
    }

    // ── Portal channel ───────────────────────────────────────────────────────
    if (channels.has('portal')) {
      await dispatchPortal(sql, kernel, postId, post, channelEvents)
    }

    // ── Instagram channel ────────────────────────────────────────────────────
    if (channels.has('instagram')) {
      await dispatchInstagram(sql, postId, channelEvents)
    }

    // SUCCESS finish: co-commit status 'sent' + all channel events + publish.succeeded.
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as Sql
      await updatePost(txSql, postId, {
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
      for (const { event, payload } of channelEvents) {
        await enqueueOutbox(txSql, event, payload, correlationId)
      }
      await enqueueOutbox(txSql, 'publish.succeeded', {
        postId,
        channelCount: channelEvents.length,
        actor,
      }, correlationId)
    })
    span.end()
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    console.error(`[dispatch] post ${postId} (tenant ${tenant.slug}) failed:`, errMessage)

    // FAILURE finish: co-commit status 'failed' + publish.failed outbox.
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as Sql
      await updatePost(txSql, postId, {
        status: 'failed',
        error: errMessage,
      })
      await enqueueOutbox(txSql, 'publish.failed', {
        postId,
        error: errMessage,
        actor,
      }, correlationId)
    })
    span.end(err)
    throw err
  }
}

// ── email channel ──────────────────────────────────────────────────────────────

async function dispatchEmail(
  sql: Sql,
  kernel: KernelClient,
  transport: ChannelTransport,
  postId: string,
  post: { title: string; body_html: string },
  origin: string,
  _correlationId: string,
  channelEvents: Array<{ event: 'channel.email.sent' | 'channel.portal.sent' | 'channel.instagram.enqueued'; payload: unknown }>,
): Promise<void> {
  // Build recipient list from post_recipients (mailing lists + KC groups).
  const recipientRows = await getPostChannelRecipients(sql, postId, 'email')
  const recipients = await buildRecipientList(sql, recipientRows, kernel)

  let delivered = 0
  let failed = 0
  let lastError: unknown

  for (const { email } of recipients) {
    const claim = await claimRecipient(sql, postId, email)
    if (claim !== 'fresh') continue // already-sent or in-flight

    const token = await addSendToken(sql, randomUUID(), postId, email)
    const unsubUrl = `${origin}/content/unsubscribe?token=${token}`
    const personalizedHtml = injectUnsubscribeFooter(post.body_html, unsubUrl)

    try {
      const info = await transport.send({
        to: email,
        subject: post.title,
        html: personalizedHtml,
      })
      await markSent(sql, postId, email, String(info.id))
      delivered += 1
    } catch (err) {
      // F1-FIX-07 H07: mark the row 'failed' (not a lingering 'claimed') so the
      // next dispatch re-claims it at once. A lingering claim read 'in-flight'
      // for 15 min, so a retry inside that window skipped the recipient and
      // still flipped the post to 'sent'.
      const message = err instanceof Error ? err.message : String(err)
      await markFailed(sql, postId, email, message)
      failed += 1
      lastError = err
      console.error(`[dispatch] email send to ${email} (post ${postId}) failed:`, message)
    }
  }

  if (failed > 0) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
    throw new Error(`${failed} email recipient(s) failed to send${detail}`)
  }

  // Record the channel.email.sent event (will be co-committed in the outer tx).
  channelEvents.push({
    event: 'channel.email.sent',
    payload: { postId, recipientCount: recipients.length, deliveredCount: delivered },
  })
}

// ── portal channel ──────────────────────────────────────────────────────────────

async function dispatchPortal(
  sql: Sql,
  kernel: KernelClient,
  postId: string,
  post: { title: string; body_html: string },
  channelEvents: Array<{ event: 'channel.email.sent' | 'channel.portal.sent' | 'channel.instagram.enqueued'; payload: unknown }>,
): Promise<void> {
  // Check if there is an existing publication (re-publish path).
  // The kernel endpoint is idempotent via content_origin_post_id UNIQUE.
  const { news_posts_id } = await kernel.portalPublish(
    postId,
    post.title,
    post.body_html,
  )

  // Store the linkage (post_id, 'portal') → news_posts_id as external_ref.
  await createPublication(sql, {
    post_id: postId,
    channel: 'portal',
    external_ref: news_posts_id,
  })

  channelEvents.push({
    event: 'channel.portal.sent',
    payload: { postId, news_posts_id },
  })
}

// ── instagram channel ──────────────────────────────────────────────────────────

async function dispatchInstagram(
  sql: Sql,
  postId: string,
  channelEvents: Array<{ event: 'channel.email.sent' | 'channel.portal.sent' | 'channel.instagram.enqueued'; payload: unknown }>,
): Promise<void> {
  // createPublishOp is idempotent (UNIQUE post_id, op).
  await createPublishOp(sql, { post_id: postId })

  channelEvents.push({
    event: 'channel.instagram.enqueued',
    payload: { postId },
  })
}
