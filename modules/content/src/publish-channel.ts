// services/content/src/publish-channel.ts
//
// SYNCHRONOUS per-channel publish for the content leaf — the service-mode
// counterpart of the kernel's publishPost(postId, channel) orchestrator.
//
// The whole-post dispatch() (dispatch.ts, POST /api/v1/posts/:id/publish → 202)
// publishes ALL enabled channels at once behind a post-level claim and reports
// only via the outbox. The kernel UI's publish button is PER-channel and expects
// a synchronous PublishResult (email 'sent'/'failed', portal 'published'), so the
// kernel route (in service mode) calls the leaf's per-channel endpoint, which
// runs THIS function. It mirrors the kernel renderers' publish() semantics
// against the leaf's own DB + kernel callbacks:
//
//   email:  per-recipient delivery-ledger claim → kernel.sendMail → mark. SMTP
//           unconfigured / no recipients surface as a clean status:'failed'
//           result (NOT a throw), matching emailRenderer. On SMTP-unconfigured
//           we RELEASE the just-made claim (releaseClaim) so a later publish sees
//           the recipient 'fresh' again — the kernel pre-checks SMTP and claims
//           nothing; the leaf can only discover it via the send throw, so it
//           undoes the claim to reach the same durable state.
//   portal: idempotent kernel.portalPublish (anchored by content_origin_post_id) →
//           record content.publications linkage → mirrors portalRenderer.
//   instagram: enqueue a content.publish_ops row (idempotent) → 'scheduled'.
//           Matches dispatch.ts dispatchInstagram (the leaf drain is the
//           disabled-by-default gate); the kernel route also gates it behind the
//           ungranted content.publish.instagram capability, so this is only
//           reached on the activation path.
//
// Per-channel status is advanced on content.post_channels (NOT the post-level
// content.posts.status the whole-post dispatch/claim uses), exactly as the kernel
// renderers call backend.setChannelStatus. This is why the manual per-channel
// publish and the whole-post scheduler can coexist without fighting over state.

import { randomUUID } from 'node:crypto'
import { noopTracer, type TracerPort } from '@gremion/ports/tracer'
import type { ContentEvent } from '@gremion/ports/broker'
import type { Sql, TenantRef } from './tenant-store.js'
import { MailUnconfiguredError, type KernelClient } from './kernel-client.js'
import { enqueueOutbox } from './outbox.js'
import { checkLinkBase } from './link-base.js'
import {
  getPost,
  getChannelRow,
  setChannelStatus,
  getPostChannelRecipients,
  claimDelivery,
  markSent,
  markFailed,
  releaseClaim,
  addSendToken,
  getPublication,
  createPublication,
  createPublishOp,
  type ContentPost,
} from './store/index.js'
import {
  buildRecipientList,
  injectUnsubscribeFooter,
  type ChannelTransport,
} from './dispatch.js'

// ── contract types (structurally identical to the kernel PublishResult) ────────

export type ChannelId = 'email' | 'portal' | 'instagram'
export type ChannelStatus = 'draft' | 'scheduled' | 'sent' | 'published' | 'failed'

/**
 * The synchronous outcome of a per-channel publish. The kernel service-client
 * parses this JSON straight into the kernel's PublishResult — keep the field set
 * (channel/status/recipientCount/externalRef/warnings/detail) verbatim.
 */
export interface PublishResult {
  channel: ChannelId
  status: ChannelStatus
  recipientCount?: number
  externalRef?: string
  warnings: string[]
  detail?: string
}

/**
 * Thrown when the post is unknown or the channel row is missing/disabled. The
 * leaf route maps this to a 409; the kernel service-client re-throws its own
 * ChannelNotPublishableError so the kernel route branches identically for both
 * backends.
 */
export class ChannelNotPublishableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelNotPublishableError'
  }
}

export interface PublishChannelDeps {
  /** Per-tenant postgres-js Sql (from storeFor(tenant)). */
  sql: Sql
  /** Kernel callback client (resolveGroup + sendMail + portalPublish). */
  kernel: KernelClient
  /** Email transport (the kernel send-mail adapter) — only used for email. */
  emailTransport: ChannelTransport
  /**
   * This tenant's external origin for unsubscribe links (no trailing slash).
   * Checked per email publish (checkLinkBase): unset/malformed/loopback fails
   * the publish before any recipient is claimed (K5#8).
   */
  origin: string
  /** Local development only: accept a loopback origin (CONTENT_ALLOW_LOOPBACK_LINKS=1). */
  allowLoopbackLinks?: boolean
  /**
   * The correlation id for this publish. Injected by the HTTP publish route from
   * the inbound x-correlation-id header so the co-committed outbox row (and the
   * downstream NATS envelope) carries the kernel's id. Falls back to the postId
   * when absent — matching dispatch()'s correlation fallback.
   */
  correlationId?: string
  /** Optional TracerPort for span emission. Defaults to noopTracer. */
  tracer?: TracerPort
}

/**
 * A per-channel publish outcome. `finish`, present only on SUCCESS, is the
 * status flip (channel-scoped; instagram has none) + the outbox event to
 * co-commit in ONE transaction — exactly as dispatch() co-commits each finished
 * channel's status update AND its outbox event. A FAILED publish carries no
 * `finish`, so it invents no event and its failure status flip (done inline on
 * the caller's sql) stands alone.
 */
interface ChannelOutcome {
  result: PublishResult
  finish?: {
    status?: { channel: ChannelId; value: ChannelStatus }
    event: ContentEvent
    payload: unknown
  }
}

// ── entry point ────────────────────────────────────────────────────────────────

/**
 * Publish ONE post to ONE channel synchronously and return the PublishResult.
 * @throws {ChannelNotPublishableError} when the post is unknown or the channel
 *   row is missing/disabled.
 */
export async function publishChannel(
  tenant: TenantRef,
  postId: string,
  channel: ChannelId,
  deps: PublishChannelDeps,
): Promise<PublishResult> {
  const { sql, kernel, emailTransport, origin } = deps
  const correlationId = deps.correlationId ?? postId
  const tracer = deps.tracer ?? noopTracer
  const span = tracer.startSpan('content.publish-channel', {
    postId,
    channel,
    tenant: tenant.slug,
  })

  try {
    const post = await getPost(sql, postId)
    if (!post) throw new ChannelNotPublishableError('post not found')

    const channelRow = await getChannelRow(sql, postId, channel)
    if (!channelRow) throw new ChannelNotPublishableError('channel not found')
    if (!channelRow.enabled) throw new ChannelNotPublishableError('channel is disabled')

    let outcome: ChannelOutcome
    switch (channel) {
      case 'email':
        outcome = await publishEmail(
          sql,
          kernel,
          emailTransport,
          origin,
          deps.allowLoopbackLinks === true,
          postId,
          post,
        )
        break
      case 'portal':
        outcome = await publishPortal(sql, kernel, postId, post)
        break
      case 'instagram':
        outcome = await publishInstagram(sql, postId)
        break
    }

    // SUCCESS finish: co-commit the (optional) per-channel status flip AND the
    // outbox event in ONE tx, so a publish never leaves a status advance without
    // its event (or vice versa) — mirrors dispatch()'s per-channel co-commit.
    if (outcome.finish) {
      const finish = outcome.finish
      await sql.begin(async (tx) => {
        const txSql = tx as unknown as Sql
        if (finish.status) {
          await setChannelStatus(txSql, postId, finish.status.channel, finish.status.value)
        }
        await enqueueOutbox(txSql, finish.event, finish.payload, correlationId)
      })
    }

    // A failed outcome is RETURNED, not thrown (the kernel UI renders it), so
    // mark the span failed explicitly or the trace would show a clean publish.
    if (outcome.result.status === 'failed') {
      span.end(new Error(outcome.result.detail ?? 'publish failed'))
    } else {
      span.end()
    }
    return outcome.result
  } catch (err) {
    span.end(err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}

// ── email channel (mirror of emailRenderer.publish) ─────────────────────────────

async function publishEmail(
  sql: Sql,
  kernel: KernelClient,
  transport: ChannelTransport,
  origin: string,
  allowLoopback: boolean,
  postId: string,
  post: ContentPost,
): Promise<ChannelOutcome> {
  const warnings: string[] = []

  // K5#8 / K5#33: every mail carries an unsubscribe link built from `origin`.
  // An unusable base (unset, malformed, loopback) is a config gap: return a
  // clean failed result BEFORE claiming anyone, channel status untouched (as
  // for SMTP-unconfigured), so a retry once the base is fixed sees all fresh.
  const linkBase = checkLinkBase(origin, { allowLoopback })
  if (!linkBase.usable) {
    return {
      result: {
        channel: 'email',
        status: 'failed',
        recipientCount: 0,
        warnings: [linkBase.reason],
        detail: 'unusable public base URL',
      },
    }
  }
  const base = linkBase.base

  const recipientRows = await getPostChannelRecipients(sql, postId, 'email')
  const recipients = await buildRecipientList(sql, recipientRows, kernel)

  // No recipients resolved → surface as failed so the operator notices the empty
  // audience (rather than a silent 'sent').
  if (recipients.length === 0) {
    await setChannelStatus(sql, postId, 'email', 'failed')
    return {
      result: {
        channel: 'email',
        status: 'failed',
        recipientCount: 0,
        warnings: ['no recipients resolved'],
        detail: 'no recipients',
      },
    }
  }

  let sentCount = 0
  let alreadySentCount = 0
  let failedCount = 0
  let smtpUnconfigured = false

  // buildRecipientList already lowercases; keep emailLower for the ledger lookups.
  for (const { email } of recipients) {
    const emailLower = email.toLowerCase()

    const { result: claim, claimedAt } = await claimDelivery(sql, postId, emailLower)
    if (claim === 'already-sent') {
      alreadySentCount += 1
      continue
    }
    if (claim !== 'fresh') continue // 'in-flight' — another worker owns it

    const token = await addSendToken(sql, randomUUID(), postId, emailLower)
    const unsubUrl = `${base}/content/unsubscribe?token=${encodeURIComponent(token)}`
    const personalizedHtml = injectUnsubscribeFooter(post.body_html, unsubUrl)

    try {
      const info = await transport.send({
        to: email,
        subject: post.title,
        html: personalizedHtml,
      })
      await markSent(sql, postId, emailLower, String(info.id))
      sentCount += 1
    } catch (err) {
      if (err instanceof MailUnconfiguredError) {
        // SMTP is unconfigured tenant-wide → nothing was sent for THIS recipient
        // and nothing can be sent for the remaining fresh ones. Release the claim
        // so a retry (once SMTP is configured) sees it 'fresh', flag it, and STOP
        // the pass. Do NOT keep looping: the rest would fail identically, and a
        // recipient already-sent on a PRIOR pass must not let the pass report
        // success while these un-sent ones are silently dropped.
        await releaseClaim(sql, postId, emailLower, claimedAt ?? undefined)
        smtpUnconfigured = true
        break
      }
      // Per-recipient send failure: isolate it and keep sending the others. The
      // 'failed' row is re-claimed by the next publish (claimRecipient takes
      // over failed rows, F1-FIX-07 H07), so the recipient is retried, not lost.
      const message = err instanceof Error ? err.message : String(err)
      // The claim token keeps a late failure off a claim another worker took over.
      await markFailed(sql, postId, emailLower, message, claimedAt ?? undefined)
      failedCount += 1
      warnings.push(`send to ${emailLower} failed: ${message}`)
    }
  }

  // SMTP unconfigured → the publish could NOT deliver to the un-sent recipients,
  // so it is a failure regardless of how many were already sent on a PRIOR pass
  // (mirrors the kernel emailRenderer's SMTP pre-check, which returns 'failed'
  // unconditionally). sentCount === 0 is the common case (SMTP down for the whole
  // pass): return the clean config-gap result WITHOUT advancing channel status
  // (as the kernel pre-check does, leaving every recipient 'fresh' for a retry).
  // sentCount > 0 means SMTP dropped mid-pass after real sends (config is static
  // per request, so near-impossible): mark the channel failed + warn so the
  // operator re-publishes the remainder.
  if (smtpUnconfigured) {
    if (sentCount === 0) {
      return {
        result: {
          channel: 'email',
          status: 'failed',
          recipientCount: 0,
          warnings,
          detail: 'SMTP not configured',
        },
      }
    }
    await setChannelStatus(sql, postId, 'email', 'failed')
    return {
      result: {
        channel: 'email',
        status: 'failed',
        recipientCount: sentCount,
        warnings: [...warnings, 'SMTP became unconfigured mid-send — remaining recipients not sent'],
        detail: 'SMTP not configured',
      },
    }
  }

  const delivered = sentCount + alreadySentCount
  if (delivered === 0) {
    await setChannelStatus(sql, postId, 'email', 'failed')
    return {
      result: {
        channel: 'email',
        status: 'failed',
        recipientCount: 0,
        warnings: failedCount > 0 ? [...warnings, 'all sends failed'] : warnings,
        detail: 'all sends failed',
      },
    }
  }

  // PARTIAL (F1-FIX-07 H07): some recipients were delivered, some sends threw.
  // The channel must NOT read 'sent' while a recipient is still un-mailed — the
  // operator re-publishes, and the failed rows are re-claimed (and only they are
  // sent again). No channel.email.sent event: the channel is not finished yet.
  if (failedCount > 0) {
    await setChannelStatus(sql, postId, 'email', 'failed')
    return {
      result: {
        channel: 'email',
        status: 'failed',
        recipientCount: sentCount,
        warnings: [...warnings, `${failedCount} recipient(s) not delivered — publish again to retry them`],
        detail: `${failedCount} send(s) failed`,
      },
    }
  }

  // SUCCESS: the channel status flip to 'sent' is co-committed with the outbox
  // event by the caller. The event payload mirrors dispatch()'s channel.email.sent
  // shape: recipientCount = resolved audience, deliveredCount = freshly-sent count.
  return {
    result: { channel: 'email', status: 'sent', recipientCount: sentCount, warnings },
    finish: {
      status: { channel: 'email', value: 'sent' },
      event: 'channel.email.sent',
      payload: { postId, recipientCount: recipients.length, deliveredCount: sentCount },
    },
  }
}

// ── portal channel (mirror of portalRenderer.publish) ───────────────────────────

async function publishPortal(
  sql: Sql,
  kernel: KernelClient,
  postId: string,
  post: ContentPost,
): Promise<ChannelOutcome> {
  // The kernel portal-publish callback is idempotent (anchored by
  // content_origin_post_id UNIQUE; externalRef is a secondary key for pre-047
  // rows). Passing the stored external_ref on re-publish targets the same
  // news_posts row. The kernel re-sanitizes body_html at its storage boundary.
  const existing = await getPublication(sql, postId, 'portal')
  const { news_posts_id } = await kernel.portalPublish(
    postId,
    post.title,
    post.body_html,
    existing?.external_ref ?? undefined,
  )

  // Upsert the linkage (post_id, 'portal') → news_posts_id.
  await createPublication(sql, {
    post_id: postId,
    channel: 'portal',
    external_ref: news_posts_id,
  })

  // SUCCESS: co-commit the 'published' status flip + the outbox event (payload
  // mirrors dispatch()'s channel.portal.sent shape).
  return {
    result: { channel: 'portal', status: 'published', externalRef: news_posts_id, warnings: [] },
    finish: {
      status: { channel: 'portal', value: 'published' },
      event: 'channel.portal.sent',
      payload: { postId, news_posts_id },
    },
  }
}

// ── instagram channel (mirror of dispatch.ts dispatchInstagram) ──────────────────

async function publishInstagram(sql: Sql, postId: string): Promise<ChannelOutcome> {
  // Purely outbox: createPublishOp enqueues a 'pending' row (idempotent —
  // UNIQUE(post_id, op)) drained by the leaf scheduler's IG reconcile loop. The
  // drain is the disabled-by-default gate (marks ops failed when unconfigured),
  // so — like dispatch.ts — no configuration check happens here. No per-channel
  // status change (matches the kernel IG renderer, which returns 'scheduled'
  // without advancing post_channels.status).
  await createPublishOp(sql, { post_id: postId })
  // SUCCESS: co-commit the outbox event only (no status flip), mirroring
  // dispatch()'s channel.instagram.enqueued shape.
  return {
    result: {
      channel: 'instagram',
      status: 'scheduled',
      detail: 'queued for Instagram publish',
      warnings: [],
    },
    finish: {
      event: 'channel.instagram.enqueued',
      payload: { postId },
    },
  }
}
