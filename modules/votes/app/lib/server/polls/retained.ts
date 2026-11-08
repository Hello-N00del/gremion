// src/lib/server/polls/retained.ts
// Module Karenz (phase 2, Task 13): what the votes module hands over for the sealed copy at switch-off.
//
// One line per poll of the tenant: a poll that is closed, and a poll that is open now and is locked by
// the participant right after this step (the extractor runs BEFORE the lock, and again on a retry after
// it). Tallies only (catalogue RC-GOV-RES): who voted what stays out; the per-voter recorded votes keep
// their own row (RC-MOD-DATA) and are not copied here. Without this copy the final day would delete
// the recorded results of every poll that no protocol references.
//
// The lines name no person: `persons` stays empty, so an Art. 17 erasure has nothing to redact.
import type { RetentionExtractor } from '$lib/server/module-karenz/retained/extractors'
import { createPollsClient } from './polls-client'

/** The kind under which the participant records its items (one per poll it locked). */
export const POLL_ITEM_KIND = 'poll'

/** The id of the sealed copy; the final-day check looks the copy up under it. */
export const POLL_RESULTS_EXTRACTOR_ID = 'votes.poll-results'

export const pollResultsExtractor: RetentionExtractor = {
  id: POLL_RESULTS_EXTRACTOR_ID,
  catalogueId: 'votes',
  retentionClass: 'RC-GOV-RES',
  async *extract(ctx) {
    const polls = createPollsClient({ tenantId: ctx.tenant.id })
    // a poll with an item was locked (or is about to be) at switch-off, whatever its deadline reads now
    const locked = new Set((await ctx.items.list(POLL_ITEM_KIND)).map((i) => i.externalId))
    const all = (await polls.listPolls()).toSorted((a, b) => a.id - b.id)
    for (const p of all) {
      const full = await polls.getPollWithOptions(p.id)
      const closedBeforeSwitchOff = p.status.expired && !locked.has(String(p.id)) && p.configuration.expire > 0
      const at = closedBeforeSwitchOff ? new Date(p.configuration.expire * 1000) : ctx.switchedOffAt
      const options = full.options ?? []
      yield {
        id: String(p.id),
        data: {
          title: p.configuration.title,
          closedOrLockedAt: at.toISOString(),
          options: options.map((o) => o.text),
          tally: options.map((o) => ({ option: o.text, count: o.votes.count, yes: o.votes.yes, no: o.votes.no, maybe: o.votes.maybe })),
        },
        persons: [],
      }
    }
  },
}
