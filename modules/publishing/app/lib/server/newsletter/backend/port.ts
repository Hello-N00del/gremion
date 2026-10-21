// gremion-ui/src/lib/server/newsletter/backend/port.ts
// Task 12 — branch-by-abstraction seam.
//
// NewsletterBackendPort is the interface that every consumer of the newsletter
// subsystem will eventually call (Task 13 migration). The method set is derived
// by enumerating every newsletter-db / newsletter-sender function that the
// ~21 consumer files actually import/call:
//
//   Mailing lists:
//     createMailingList, listMailingLists, deleteMailingList
//     addMember, listMembers, deleteMember
//
//   Newsletter CRUD + scheduling:
//     createNewsletter, listNewsletters, getNewsletter, updateNewsletter
//     setNewsletterRecipients, getNewsletterRecipients
//     countSubscribers, countNewsletterRecipients
//     getScheduledDueNewsletters
//
//   Dispatch (corresponds to dispatchNewsletter in newsletter-sender.ts):
//     dispatchNow(newsletterId, actorSub, groupMemberFetcher)
//
//   Delivery ledger (SP-2 §3):
//     claimNewsletterForSending, claimRecipient, markSent, releaseDeliveryClaim
//
//   Token / unsubscribe:
//     addSendToken, consumeUnsubscribeToken (= addUnsubscribeByToken),
//     addUnsubscribe, isUnsubscribed, purgeSendTokensOlderThan90Days
//
//   Audit:
//     recordNewsletterAudit
//
// Task 14: all methods return Promise<T> so that the ServiceNewsletterClient
// (HTTP ACL) implements this interface over the newsletter leaf service.
//
// Task 23 (old-path decommission): the monolith SQLite backend is gone — the
// leaf service is the ONLY implementation. The domain DTO types below used to
// live in the now-removed newsletter-db.ts; they are the leaf↔kernel transfer
// shapes, so they now live HERE on the pure-interface seam.
//
// This file has NO runtime dependencies — it is a pure TypeScript interface.
// DO NOT import from any server module here.

// ── Domain transfer types (relocated from the removed newsletter-db.ts) ──────

export interface MailingList {
  id: number
  name: string
  created_at: string
}

export interface MailingListMember {
  id: number
  list_id: number
  email: string
  name: string | null
  source: 'csv' | 'manual'
  created_at: string
}

export interface Newsletter {
  id: number
  title: string
  odt_path: string
  subject: string
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
  scheduled_at: string | null
  sent_at: string | null
  error: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export interface NewsletterRecipient {
  newsletter_id: number
  mailing_list_id: number | null
  keycloak_group_id: string | null
}

/** Per-recipient delivery-claim outcome (leaf delivery ledger). */
export type ClaimResult = 'fresh' | 'already-sent' | 'in-flight'

/** A resolved newsletter recipient (relocated from the removed newsletter-sender.ts). */
export interface Recipient {
  email: string
  name: string | null
}

/** Group-member resolver injected by call sites (KC admin or stub in tests). */
export type GroupMemberFetcher = (groupId: string) => Promise<Recipient[]>

export interface NewsletterBackendPort {
  /**
   * Discriminant identifying which implementation is in use.
   *
   * Consumers that must branch on transport semantics (e.g. the send-now route,
   * where the SQLite path pre-claims locally but the service path lets the leaf
   * claim atomically inside its own POST /send) read this instead of re-reading
   * `process.env.NEWSLETTER_BACKEND`. Keeping the discriminant on the port means
   * the env→impl mapping lives in exactly one place (index.ts getNewsletterBackend).
   */
  readonly kind: 'sqlite' | 'service'

  // ── Mailing lists ────────────────────────────────────────────────────────────
  createMailingList(name: string): Promise<MailingList>
  listMailingLists(): Promise<MailingList[]>
  deleteMailingList(id: number): Promise<void>

  // ── Mailing list members ─────────────────────────────────────────────────────
  addMember(listId: number, email: string, name: string | null, source: 'csv' | 'manual'): Promise<void>
  listMembers(listId: number): Promise<MailingListMember[]>
  /**
   * Delete one mailing-list member. `listId` scopes the delete to the list the
   * member belongs to (the leaf DELETE route is /lists/:id/members/:memberId).
   * The SQLite impl deletes by `memberId` alone (member ids are globally unique
   * in the single-tenant SQLite store); the service impl builds the real
   * list-scoped URL so the placeholder `lists/0/...` is gone (F-IMP).
   */
  deleteMember(listId: number, memberId: number): Promise<void>

  // ── Newsletter CRUD ──────────────────────────────────────────────────────────
  createNewsletter(data: {
    title: string
    odt_path: string
    subject: string
    created_by: string
  }): Promise<Newsletter>
  listNewsletters(): Promise<Newsletter[]>
  getNewsletter(id: number): Promise<Newsletter | null>
  updateNewsletter(
    id: number,
    data: Partial<Pick<Newsletter, 'subject' | 'status' | 'scheduled_at' | 'sent_at' | 'error'>>
  ): Promise<void>

  // ── Recipients ───────────────────────────────────────────────────────────────
  setNewsletterRecipients(
    newsletterId: number,
    recipients: Array<{ mailing_list_id?: number; keycloak_group_id?: string }>
  ): Promise<void>
  getNewsletterRecipients(newsletterId: number): Promise<NewsletterRecipient[]>

  // ── Aggregate counts (grid / stats) ─────────────────────────────────────────
  countSubscribers(): Promise<number>
  countNewsletterRecipients(newsletterId: number): Promise<number>

  // ── Scheduler support ────────────────────────────────────────────────────────
  getScheduledDueNewsletters(): Promise<Newsletter[]>

  // ── Dispatch ─────────────────────────────────────────────────────────────────
  /** Fire-and-forget dispatch: claim → build list → send. Returns when done. */
  dispatchNow(
    newsletterId: number,
    actorSub: string,
    groupMemberFetcher: GroupMemberFetcher
  ): Promise<void>

  // ── Delivery ledger (SP-2 §3) ────────────────────────────────────────────────
  claimNewsletterForSending(id: number): Promise<boolean>
  claimRecipient(newsletterId: number, email: string): Promise<ClaimResult>
  markSent(newsletterId: number, email: string, messageId: string): Promise<void>
  releaseDeliveryClaim(newsletterId: number, email: string): Promise<void>

  // ── Token / unsubscribe ──────────────────────────────────────────────────────
  addSendToken(token: string, newsletterId: number, email: string): Promise<string>
  /** Consume an unsubscribe token atomically. Alias of addUnsubscribeByToken. */
  consumeUnsubscribeToken(token: string): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'expired' }>
  addUnsubscribe(email: string, token: string): Promise<void>
  isUnsubscribed(email: string): Promise<boolean>
  purgeSendTokensOlderThan90Days(): Promise<void>

  // ── Audit ────────────────────────────────────────────────────────────────────
  recordNewsletterAudit(newsletterId: number, actorSub: string, action: string): Promise<void>
}
