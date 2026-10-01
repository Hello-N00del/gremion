// services/content/src/store/index.ts
//
// Barrel re-export of all per-tenant PG store ops.
// Import from here rather than from individual modules.

export type { MailingList, MailingListMember } from './lists.js'
export {
  createMailingList,
  listMailingLists,
  deleteMailingList,
  addListMember,
  listMembers,
  removeListMember,
} from './lists.js'

export type { ContentPost, DueChannel } from './posts.js'
export {
  createPost,
  listPosts,
  getPost,
  updatePost,
  claimPostForPublish,
  resetStuckPublishing,
  listDueScheduledChannels,
  countPostRecipients,
} from './posts.js'

export type { PostRecipient } from './post-channels.js'
export {
  setPostChannelRecipients,
  getPostChannelRecipients,
} from './post-channels.js'

export type { PostMedia } from './media.js'
export {
  createMedia,
  getMedia,
  listMediaByPost,
} from './media.js'

export type { ClaimResult, DeliveryClaim } from './deliveries.js'
export {
  claimRecipient,
  claimDelivery,
  markSent,
  recordDelivered,
  markFailed,
  releaseClaim,
} from './deliveries.js'

export type { ChannelRow, ChannelStatus } from './channels.js'
export {
  getChannelRow,
  setChannelStatus,
  failScheduledChannel,
} from './channels.js'

export {
  addUnsubscribe,
  isUnsubscribed,
  addSendToken,
  purgeSendTokensOlderThan90Days,
} from './tokens.js'

export type { Publication } from './publications.js'
export {
  createPublication,
  getPublication,
  listPublications,
} from './publications.js'

export type { PublishOp } from './publish-ops.js'
export {
  createPublishOp,
  getPublishOp,
  updatePublishOp,
  drainPublishOps,
} from './publish-ops.js'

export { recordContentAudit } from './audit.js'
