// src/lib/server/polls/karenz.ts
// Module Karenz (phase 2, Task 13): the votes participant. Nextcloud Polls holds the polls of EVERY
// tenant in one instance, so the Karenz of one tenant must freeze, restore and delete only its own
// polls: every call goes through a client pinned to the Karenz context's tenant (tenant-scope.ts), and
// a foreign poll answers exactly like a missing one.
//
// switchOff   Every open poll is locked by moving its deadline to the past. The ORDER IS LOAD-BEARING:
//             the item (with the original deadline and the remaining seconds) is recorded FIRST, then
//             the poll is changed, then the lock is read back. A crash anywhere in between leaves a
//             recorded item that the next run resolves by reading the poll, never a closed poll
//             without a way back. A refused lock leaves the poll open, marks the item `lock_failed`
//             and fails the step with the poll id (never the title).
// restore     The deadline becomes "now plus the stored remaining time" (a poll without a deadline
//             gets none again). A poll that is still open, or that ran out by itself while untouched,
//             is not written. A refused unlock leaves the poll locked and the item `unlock_failed`.
// finalize    A poll is deleted ONLY when a sealed line for it exists and no protocol references it.
//             A poll without a sealed line is kept and reported: the sealed copy is what the council
//             keeps of a deleted poll, so a missing line must never become a silent loss.
//
// Every phase processes ALL polls and then throws one KarenzPartialError, and every phase is
// idempotent. What a failure says is "poll <id>: <what>", never a title or a person.
import type { DeletionItem, DeletionPreviewProvider } from '$lib/modules/switch-preview'
import { KarenzPartialError, type KarenzContext, type KarenzParticipant } from '$lib/server/module-karenz/participants'
import { openLines } from '$lib/server/module-karenz/retained/crypto'
import { retainedRecordIdFor } from '$lib/server/module-karenz/retained/store'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'
import { createPollsClient, type NcPoll } from './polls-client'
import { POLL_ITEM_KIND, POLL_RESULTS_EXTRACTOR_ID } from './retained'
import { pollAccessStatus } from './tenant-scope'

/** What the participant stores per locked poll (the item payload). */
interface PollPayload {
  /** The deadline before the lock (epoch seconds, 0 = none). */
  expire: number
  /** Seconds left at the lock, or null for a poll without a deadline. */
  remainingS: number | null
  /** The result visibility before the lock; absent when Nextcloud did not report one. */
  showResults?: string
}

const nowEpoch = (ctx: KarenzContext): number => Math.floor(ctx.now().getTime() / 1000)

const clientFor = (ctx: KarenzContext) => createPollsClient({ tenantId: ctx.tenant.id })

/** The HTTP status in a Polls error, when there is one (only the status ever reaches an item detail). */
function statusOf(e: unknown): number | null {
  const s = pollAccessStatus(e)
  if (s !== null) return s
  const m = e instanceof Error ? /→\s*(\d{3})\b/.exec(e.message) : null
  return m ? Number(m[1]) : null
}

const isGone = (e: unknown): boolean => statusOf(e) === 404

const why = (e: unknown): string => {
  const s = statusOf(e)
  return s !== null ? `HTTP ${s}` : e instanceof Error ? e.name : 'error'
}

function payloadOf(item: KarenzItemRow): PollPayload | null {
  const p = item.payload as Partial<PollPayload> | null
  if (!p || typeof p.expire !== 'number') return null
  return { expire: p.expire, remainingS: typeof p.remainingS === 'number' ? p.remainingS : null, ...(typeof p.showResults === 'string' ? { showResults: p.showResults } : {}) }
}

/** The lock took effect: the poll reads as closed and its deadline is not the one recorded. */
const lockApplied = (poll: NcPoll, payload: PollPayload): boolean => poll.status.expired && poll.configuration.expire !== payload.expire

/** Collects the failures of one phase: one poll never stops the others, the phase fails at the end. */
class Run {
  readonly failures: string[] = []
  constructor(private readonly ctx: KarenzContext) {}

  fail(pollId: string | number, what: string): void {
    const label = `poll ${pollId}: ${what}`
    this.ctx.log(label)
    this.failures.push(label)
  }

  /** Record the new state of an item; false (and a failure) when the ledger refused. */
  async set(item: KarenzItemRow, state: ItemState, detail?: string): Promise<boolean> {
    try {
      await this.ctx.items.setState(item.itemId, state, detail)
      return true
    } catch {
      this.fail(item.externalId, `could not record ${state}`)
      return false
    }
  }

  done(): void {
    if (this.failures.length > 0) throw new KarenzPartialError(this.failures)
  }
}

/** Lock one recorded item's poll and read the lock back. */
async function lockPoll(ctx: KarenzContext, run: Run, item: KarenzItemRow, payload: PollPayload): Promise<void> {
  const polls = clientFor(ctx)
  const id = Number(item.externalId)
  try {
    // one second in the past: Nextcloud reads a deadline as passed only when it is strictly earlier than now
    await polls.setConfiguration(id, { expire: nowEpoch(ctx) - 1, ...(payload.showResults !== undefined ? { showResults: 'never' } : {}) })
    const after = await polls.getPoll(id)
    if (!after.status.expired) {
      run.fail(id, 'still open after the lock')
      await run.set(item, 'lock_failed', 'still open after the lock')
      return
    }
  } catch (e) {
    if (isGone(e)) {
      await run.set(item, 'gone')
      return
    }
    run.fail(id, `lock refused (${why(e)})`)
    await run.set(item, 'lock_failed', `lock refused (${why(e)})`)
    return
  }
  await run.set(item, 'locked')
}

/** A recorded or lock_failed item from an earlier run: find out what happened to its poll and finish the job. */
async function resolveLock(ctx: KarenzContext, run: Run, item: KarenzItemRow): Promise<void> {
  const payload = payloadOf(item)
  if (!payload) {
    run.fail(item.externalId, 'item without a recorded deadline')
    return
  }
  let poll: NcPoll
  try {
    poll = await clientFor(ctx).getPoll(Number(item.externalId))
  } catch (e) {
    if (isGone(e)) await run.set(item, 'gone')
    else run.fail(item.externalId, `read failed (${why(e)})`)
    return
  }
  if (lockApplied(poll, payload)) await run.set(item, 'locked')
  else if (poll.status.expired) await run.set(item, 'restored', 'closed by itself before the lock')
  else await lockPoll(ctx, run, item, payload)
}

async function switchOff(ctx: KarenzContext): Promise<void> {
  const run = new Run(ctx)
  const existing = await ctx.items.list(POLL_ITEM_KIND)
  const known = new Set(existing.map((i) => i.externalId))
  for (const item of existing) if (item.state === 'recorded' || item.state === 'lock_failed') await resolveLock(ctx, run, item)

  for (const poll of (await clientFor(ctx).listPolls()).toSorted((a, b) => a.id - b.id)) {
    // already closed: nothing to freeze and nothing to reopen later; handled above or by an earlier run: skip
    if (poll.status.expired || known.has(String(poll.id))) continue
    const expire = poll.configuration.expire
    const payload: PollPayload = {
      expire,
      remainingS: expire > 0 ? expire - nowEpoch(ctx) : null,
      ...(typeof poll.configuration.showResults === 'string' ? { showResults: poll.configuration.showResults } : {}),
    }
    // record FIRST: the poll is not touched before the way back is on file
    const item = await ctx.items.upsert({ kind: POLL_ITEM_KIND, externalId: String(poll.id), state: 'recorded', payload })
    await lockPoll(ctx, run, item, payload)
  }
  run.done()
}

async function restore(ctx: KarenzContext): Promise<void> {
  const run = new Run(ctx)
  const polls = clientFor(ctx)
  const pending = new Set<ItemState>(['recorded', 'lock_failed', 'locked', 'unlock_failed'])
  for (const item of (await ctx.items.list(POLL_ITEM_KIND)).filter((i) => pending.has(i.state))) {
    const id = Number(item.externalId)
    const payload = payloadOf(item)
    if (!payload) {
      run.fail(id, 'item without a recorded deadline')
      continue
    }
    try {
      const poll = await polls.getPoll(id)
      // still open: the lock never happened (or was lifted by hand); closed with its own deadline: it ran out by itself
      const neverLocked = item.state === 'recorded' || item.state === 'lock_failed'
      if (!poll.status.expired || (neverLocked && !lockApplied(poll, payload))) {
        await run.set(item, 'restored')
        continue
      }
      // at least one second: "now plus nothing" would read as closed again at once
      const expire = payload.remainingS === null ? 0 : nowEpoch(ctx) + Math.max(payload.remainingS, 1)
      await polls.setConfiguration(id, { expire, ...(payload.showResults !== undefined ? { showResults: payload.showResults } : {}) })
      if ((await polls.getPoll(id)).status.expired) {
        run.fail(id, 'still closed after the unlock')
        await run.set(item, 'unlock_failed', 'still closed after the unlock')
      } else {
        await run.set(item, 'restored')
      }
    } catch (e) {
      if (isGone(e)) {
        await run.set(item, 'gone')
        continue
      }
      run.fail(id, `unlock refused (${why(e)})`)
      await run.set(item, 'unlock_failed', `unlock refused (${why(e)})`)
    }
  }
  run.done()
}

/** The ids of the polls the sealed copy has a line for. Throws when the copy cannot be opened: nothing is deleted then. */
async function sealedPollIds(ctx: KarenzContext): Promise<Set<string>> {
  const recordId = await retainedRecordIdFor(ctx.tenant.db, ctx.karenzId, POLL_RESULTS_EXTRACTOR_ID)
  if (!recordId) return new Set()
  return new Set((await openLines(ctx.tenant.db, ctx.tenant.id, recordId)).map((l) => l.id))
}

/** The poll ids a protocol points at (protocols.approval_poll_id is the only poll link in the schema). */
async function protocolPollIds(ctx: KarenzContext): Promise<Set<string>> {
  const rows = await ctx.tenant.db<{ approval_poll_id: string }[]>`
    SELECT DISTINCT approval_poll_id FROM protocols WHERE approval_poll_id IS NOT NULL`
  return new Set(rows.map((r) => String(r.approval_poll_id)))
}

async function finalize(ctx: KarenzContext, opts: { dryRun: boolean }): Promise<{ deleted: Record<string, number> }> {
  const run = new Run(ctx)
  const polls = clientFor(ctx)
  const all = (await polls.listPolls()).toSorted((a, b) => a.id - b.id)
  if (all.length === 0) return { deleted: { polls: 0 } }
  const sealed = await sealedPollIds(ctx)
  const referenced = await protocolPollIds(ctx)
  let deleted = 0
  const remember = async (id: number, state: ItemState, detail: string): Promise<void> => {
    if (opts.dryRun) return
    try {
      await ctx.items.upsert({ kind: POLL_ITEM_KIND, externalId: String(id), state, detail })
    } catch {
      ctx.log(`poll ${id}: could not record ${state} (the deletion itself is idempotent)`)
    }
  }
  for (const poll of all) {
    const key = String(poll.id)
    if (referenced.has(key)) {
      await remember(poll.id, 'kept', 'referenced by a protocol')
      continue
    }
    if (!sealed.has(key)) {
      // the sealed copy is the only record of a deleted poll: no line, no deletion
      ctx.log(`poll ${poll.id}: no sealed line, kept`)
      if (!opts.dryRun) run.fail(poll.id, 'no sealed line, kept')
      await remember(poll.id, 'kept', 'no sealed line')
      continue
    }
    if (opts.dryRun) {
      deleted++
      continue
    }
    try {
      await polls.deletePoll(poll.id)
    } catch (e) {
      // already gone counts as deleted; anything else is reported and retried
      if (!isGone(e)) {
        run.fail(poll.id, `delete failed (${why(e)})`)
        continue
      }
    }
    deleted++
    await remember(poll.id, 'deleted', 'final deletion')
  }
  run.done()
  return { deleted: { polls: deleted } }
}

export const votesKarenz: KarenzParticipant = { catalogueId: 'votes', switchOff, restore, finalize }

/** The counts the council sees before it switches votes off (phase 1 preview seam). */
export const votesDeletionPreview: DeletionPreviewProvider = async (tenant) => {
  const all = await createPollsClient({ tenantId: tenant.id }).listPolls()
  const open = all.filter((p) => !p.status.expired).length
  const items: DeletionItem[] = [
    { key: 'open_polls', label: 'Offene Umfragen', count: open, unit: 'Umfragen' },
    { key: 'closed_polls', label: 'Abgeschlossene Umfragen', count: all.length - open, unit: 'Umfragen' },
  ]
  return items
}
