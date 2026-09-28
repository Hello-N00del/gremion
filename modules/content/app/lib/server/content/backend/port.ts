// gremion-ui/src/lib/server/content/backend/port.ts
// Task 1 — branch-by-abstraction seam.
//
// ContentBackendPort is the interface that every consumer of the content
// subsystem will call. The method set is derived by enumerating every content
// operation that the leaf content service will expose and that tasks 3, 4, 6
// and the leaf routes in Group 4 will consume.
//
// Task 2: all methods return Promise<T> so that the ServiceContentClient
// (HTTP ACL) implements this interface over the content leaf service.
//
// This file has NO runtime dependencies — it is a pure TypeScript interface.
// DO NOT import from any server module here (the PublishResult import below is
// `import type` — a pure type from a runtime-free module, erased at compile).

import type { PublishResult } from '../channels/types'

export type { PublishResult } from '../channels/types'

// ── Domain transfer types ────────────────────────────────────────────────────

export type ChannelId = 'email' | 'portal' | 'instagram'
export type ChannelStatus = 'draft' | 'scheduled' | 'sent' | 'published' | 'failed'
export type MediaRole = 'hero' | 'slide' | 'inline'
export type ClaimResult = 'fresh' | 'already-sent' | 'in-flight'

export interface Post {
  id: string
  slug: string
  title: string
  body_html: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface PostMedia {
  id: string
  post_id: string
  url: string
  role: MediaRole
  position: number
  alt: string | null
}

export interface PostChannel {
  post_id: string
  channel: ChannelId
  enabled: boolean
  status: ChannelStatus
  scheduled_at: string | null
  overrides: Record<string, unknown>
}

export interface MailingList {
  id: string
  name: string
  created_at: string
}

export interface MailingListMember {
  id: string
  mailing_list_id: string
  email: string
  name: string | null
  source: 'manual' | 'csv'
  created_at: string
}

export interface PostRecipient {
  id: string
  post_id: string
  mailing_list_id: string | null
  keycloak_group_id: string | null
}

export interface Publication {
  post_id: string
  channel: ChannelId
  external_ref: string | null
  published_at: string | null
}

export interface PublishOp {
  id: string
  post_id: string
  channel: 'instagram'
  op: 'publish'
  status: 'pending' | 'ok' | 'failed'
  attempts: number
  next_attempt_at: string | null
  first_failed_at: string | null
  last_error: string | null
  external_ref: string | null
}

export interface ContentBackendPort {
  /**
   * Discriminant identifying which implementation is in use.
   *
   * Consumers that must branch on transport semantics read this instead of
   * re-reading env. Keeping the discriminant on the port means the
   * env→impl mapping lives in exactly one place (index.ts getContentBackend).
   */
  readonly kind: 'inprocess' | 'service'

  // ── Post CRUD ────────────────────────────────────────────────────────────
  createPost(input: { title: string; created_by: string }): Promise<Post>
  getPost(id: string): Promise<Post | null>
  listPosts(): Promise<Post[]>
  updatePostTitle(id: string, title: string): Promise<Post>
  updatePostBody(id: string, bodyHtml: string): Promise<Post>
  deletePost(id: string): Promise<void>

  // ── Media ────────────────────────────────────────────────────────────────
  listMedia(postId: string): Promise<PostMedia[]>
  addMedia(postId: string, m: { url: string; role: MediaRole; position?: number; alt?: string | null }): Promise<PostMedia>

  // ── Channels ─────────────────────────────────────────────────────────────
  getChannels(postId: string): Promise<PostChannel[]>
  ensureChannels(postId: string): Promise<void>
  setChannelEnabled(postId: string, channel: ChannelId, enabled: boolean): Promise<PostChannel>
  setChannelStatus(postId: string, channel: ChannelId, status: ChannelStatus): Promise<PostChannel>
  setChannelScheduledAt(postId: string, channel: ChannelId, scheduledAt: string | null): Promise<PostChannel>
  setChannelOverrides(postId: string, channel: ChannelId, overrides: Record<string, unknown>): Promise<PostChannel>

  // ── Mailing lists ────────────────────────────────────────────────────────
  createMailingList(name: string): Promise<MailingList>
  listMailingLists(): Promise<MailingList[]>
  deleteMailingList(id: string): Promise<void>

  // ── Mailing list members ─────────────────────────────────────────────────
  addListMember(listId: string, m: { email: string; name?: string | null; source?: 'manual' | 'csv' }): Promise<void>
  listMembers(listId: string): Promise<MailingListMember[]>
  removeListMember(listId: string, memberId: string): Promise<void>

  // ── Recipients ───────────────────────────────────────────────────────────
  setPostRecipients(postId: string, recips: { mailing_list_id?: string; keycloak_group_id?: string }[]): Promise<void>
  getPostRecipients(postId: string): Promise<PostRecipient[]>

  // ── Unsubscribe ──────────────────────────────────────────────────────────
  isUnsubscribed(email: string): Promise<boolean>
  filterUnsubscribed(emailsLower: string[]): Promise<Set<string>>
  addUnsubscribe(email: string): Promise<void>

  // ── Send tokens ──────────────────────────────────────────────────────────
  mintSendToken(postId: string, email: string): Promise<string>
  consumeUnsubscribeToken(token: string): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }>

  // ── Delivery ledger ──────────────────────────────────────────────────────
  claimRecipient(postId: string, emailLower: string): Promise<ClaimResult>
  markDeliverySent(postId: string, emailLower: string, messageId: string): Promise<void>
  markDeliveryFailed(postId: string, emailLower: string, error: string): Promise<void>

  // ── Publications ─────────────────────────────────────────────────────────
  getPublication(postId: string, channel: ChannelId): Promise<Publication | null>
  setPublication(postId: string, channel: ChannelId, externalRef: string | null): Promise<void>
  clearPublication(postId: string, channel: ChannelId): Promise<void>

  // ── Publish operations ───────────────────────────────────────────────────
  enqueuePublishOp(postId: string, channel: 'instagram', op: 'publish'): Promise<void>
  listDuePublishOps(): Promise<PublishOp[]>
  markPublishOpOk(opId: string, externalRef?: string): Promise<void>
  markPublishOpFailed(opId: string, error: string): Promise<void>

  // ── Per-channel publish ──────────────────────────────────────────────────
  /**
   * Publish ONE post to ONE channel and return the channel's synchronous
   * PublishResult (email 'sent'/'failed', portal 'published', instagram
   * 'scheduled'). This is the seam behind the per-channel publish route.
   *
   * - inprocess → runs the in-kernel `publishPost` orchestrator (renderers
   *   write the kernel DB).
   * - service   → POSTs the leaf's per-channel publish endpoint (the leaf runs
   *   the same per-channel path against its own DB + kernel callbacks).
   *
   * Both throw {@link ChannelNotPublishableError} when the post is unknown or the
   * channel row is missing/disabled (the route maps it to 409). SMTP-unconfigured
   * / no-recipients surface as a `status:'failed'` result (NOT a throw), so the
   * route can turn an email failure into a 422 while leaving the ledger intact.
   */
  publish(postId: string, channel: ChannelId): Promise<PublishResult>
}
