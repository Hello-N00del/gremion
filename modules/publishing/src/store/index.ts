// services/newsletter/src/store/index.ts
//
// Barrel re-export of all per-tenant PG store ops.
// Import from here rather than from individual modules.

export type { MailingList, MailingListMember } from './lists.js'
export {
  createMailingList,
  listMailingLists,
  deleteMailingList,
  addMember,
  listMembers,
  deleteMember,
  countSubscribers,
} from './lists.js'

export type { Newsletter, NewsletterRecipient } from './newsletters.js'
export {
  createNewsletter,
  listNewsletters,
  getNewsletter,
  updateNewsletter,
  setNewsletterRecipients,
  getNewsletterRecipients,
  getScheduledDueNewsletters,
  claimNewsletterForSending,
  resetStuckSending,
  countNewsletterRecipients,
} from './newsletters.js'

export {
  addUnsubscribe,
  addUnsubscribeByToken,
  isUnsubscribed,
  addSendToken,
  purgeSendTokensOlderThan90Days,
} from './tokens.js'

export { recordNewsletterAudit } from './audit.js'

export type { ClaimResult } from './deliveries.js'
export { claimRecipient, markSent } from './deliveries.js'
