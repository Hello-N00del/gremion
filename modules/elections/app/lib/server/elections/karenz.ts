// src/lib/server/elections/karenz.ts
// Module Karenz (phase 2, Task 14): the elections participant. Elections run in a Helios instance that
// is shared outside this repository, so an election's deadline is frozen through the pause port
// (helios-pause.ts) and nothing here assumes more than the port promises.
//
// switchOff   Every tracked election that is open is paused. The ORDER IS LOAD-BEARING: the item (with
//             the end date and the remaining milliseconds) is recorded FIRST, then the port locks the
//             election, then the lock is read back. A crash anywhere in between leaves a recorded item
//             that the next run resolves by reading the election, never a closed election without a
//             way back. A refusal, or a lock that did not take effect, leaves the item `lock_failed`
//             and fails the step with the election id (never the name). Closed and draft elections are
//             not touched.
// restore     The election is unlocked with the stored remaining time ("now plus remaining", never the
//             original date) and read back. An election that is open again, or that ran out by itself
//             while untouched, is not written. A refusal leaves the election locked and the item
//             `unlock_failed`.
// finalize    Nothing destructive: an election whose sealed result exists is ARCHIVED in the tenant
//             table (archived_at), nothing is removed in Helios. An election without a sealed result
//             stays as it is.
//
// Every phase processes ALL elections and then throws one KarenzPartialError, and every phase is
// idempotent. What a failure says is "election <uuid>: <what>", never a name or a person.
import type { KarenzContext, KarenzParticipant } from '$lib/server/module-karenz/participants'
import { KarenzPartialError } from '$lib/server/module-karenz/participants'
import { openLines } from '$lib/server/module-karenz/retained/crypto'
import type { RetentionExtractor } from '$lib/server/module-karenz/retained/extractors'
import { retainedRecordIdFor } from '$lib/server/module-karenz/retained/store'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'
import type { SwitchOffGuard } from '$lib/server/module-switch/guards'
import { runWithTenant } from '$lib/server/tenant/context'
import { ElectionDb } from './election-db'
import { deriveLifecycle, HeliosClient, HeliosUnavailableError, type HeliosElection } from './helios-client'
import { heliosPause, type HeliosPausePort } from './helios-pause'

/** The kind under which the participant records the elections it paused. */
export const ELECTION_ITEM_KIND = 'election'
/** The kind under which the final step records the elections it archived (a second kind: one item per (kind, id)). */
export const ELECTION_ARCHIVE_ITEM_KIND = 'election-archive'
/** The id of the sealed copy; the final-day check looks the copy up under it. */
export const ELECTION_RESULTS_EXTRACTOR_ID = 'elections.election-results'

/** What the participant stores per paused election (the item payload). */
interface ElectionPayload {
  /** The end of voting before the pause (ISO). */
  endsAt: string
  /** Milliseconds left at the pause. */
  remainingMs: number
}

const nowMs = (ctx: KarenzContext): number => ctx.now().getTime()

/** A short label of a failure: the HTTP status when there is one, else the error class. Never a message text. */
function why(e: unknown): string {
  if (e instanceof HeliosUnavailableError) return e.status !== null ? `HTTP ${e.status}` : 'unreachable'
  return e instanceof Error ? e.name : 'error'
}

function payloadOf(item: KarenzItemRow): ElectionPayload | null {
  const p = item.payload as Partial<ElectionPayload> | null
  if (!p || typeof p.endsAt !== 'string' || typeof p.remainingMs !== 'number') return null
  return { endsAt: p.endsAt, remainingMs: p.remainingMs }
}

const sameInstant = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b))

/** The pause took effect: the election reads as closed and its end is not the one recorded. */
const lockApplied = (e: HeliosElection, payload: ElectionPayload): boolean => deriveLifecycle(e) === 'closed' && !sameInstant(e.voting_ends_at, payload.endsAt)

/** The uuids of the tracked (not archived) elections, in a stable order. */
async function trackedUuids(): Promise<string[]> {
  return (await ElectionDb.findAll()).map((r) => r.helios_uuid).toSorted()
}

/** An election that Helios answers with a definite 404 no longer exists there: it cannot be open and has no result to keep. */
const isGone = (e: unknown): boolean => e instanceof HeliosUnavailableError && e.status === 404

/** Reads an election; null when Helios definitely does not know it. Network errors and 5xx still throw (fail closed). */
async function readElectionOrGone(uuid: string): Promise<HeliosElection | null> {
  try {
    return await HeliosClient.getElection(uuid)
  } catch (e) {
    if (isGone(e)) {
      console.error(`[elections-karenz] election ${uuid} is tracked but Helios answers 404`)
      return null
    }
    throw e
  }
}

/** Collects the failures of one phase: one election never stops the others, the phase fails at the end. */
class Run {
  readonly failures: string[] = []
  constructor(private readonly ctx: KarenzContext) {}

  /** `cause` is the raw error: only the short label reaches the failure list (shown to the council), the full error goes to the operator log. */
  fail(uuid: string, what: string, cause?: unknown): void {
    const label = `election ${uuid}: ${what}`
    this.ctx.log(label)
    if (cause !== undefined) console.error(`[elections-karenz] ${label}`, cause)
    this.failures.push(label)
  }

  /** Record the new state of an item; false (and a failure) when the ledger refused. */
  async set(item: KarenzItemRow, state: ItemState, detail?: string): Promise<boolean> {
    try {
      await this.ctx.items.setState(item.itemId, state, detail)
      return true
    } catch (e) {
      this.fail(item.externalId, `could not record ${state} (${why(e)})`, e)
      return false
    }
  }

  done(): void {
    if (this.failures.length > 0) throw new KarenzPartialError(this.failures)
  }
}

/** Pause one recorded item's election through the port and read the pause back. */
async function lockElection(ctx: KarenzContext, run: Run, port: HeliosPausePort, item: KarenzItemRow): Promise<void> {
  const uuid = item.externalId
  let refusal: string | null = null
  try {
    const r = await port.lock(uuid)
    if (!r.ok) refusal = r.reason.slice(0, 60)
  } catch (e) {
    refusal = why(e)
    console.error(`[elections-karenz] election ${uuid}: lock call threw`, e)
  }
  if (refusal !== null) {
    run.fail(uuid, `lock refused (${refusal})`)
    await run.set(item, 'lock_failed', `lock refused (${refusal})`)
    return
  }
  try {
    if (deriveLifecycle(await HeliosClient.getElection(uuid)) === 'open') {
      run.fail(uuid, 'still open after the lock')
      await run.set(item, 'lock_failed', 'still open after the lock')
      return
    }
  } catch (e) {
    // the lock may have taken effect: the item stays retryable and the next run reads the election back
    run.fail(uuid, `lock not read back (${why(e)})`, e)
    await run.set(item, 'lock_failed', `lock not read back (${why(e)})`)
    return
  }
  await run.set(item, 'locked')
}

/** A recorded or lock_failed item from an earlier run: find out what happened to its election and finish the job. */
async function resolveLock(ctx: KarenzContext, run: Run, port: HeliosPausePort, item: KarenzItemRow): Promise<void> {
  const payload = payloadOf(item)
  if (!payload) {
    run.fail(item.externalId, 'item without a recorded end date')
    return
  }
  let election: HeliosElection
  try {
    election = await HeliosClient.getElection(item.externalId)
  } catch (e) {
    run.fail(item.externalId, `read failed (${why(e)})`, e)
    return
  }
  if (lockApplied(election, payload)) {
    await run.set(item, 'locked')
    return
  }
  if (deriveLifecycle(election) === 'open') {
    await lockElection(ctx, run, port, item)
    return
  }
  // closed with its own end date: it ran out by itself before the lock
  await run.set(item, 'restored', 'closed by itself before the lock')
}

function switchOff(port: HeliosPausePort): KarenzParticipant['switchOff'] {
  return async (ctx) => {
    const run = new Run(ctx)
    const existing = await ctx.items.list(ELECTION_ITEM_KIND)
    const known = new Set(existing.map((i) => i.externalId))
    for (const item of existing) if (item.state === 'recorded' || item.state === 'lock_failed') await resolveLock(ctx, run, port, item)

    for (const uuid of await trackedUuids()) {
      if (known.has(uuid)) continue
      let election: HeliosElection
      try {
        election = await HeliosClient.getElection(uuid)
      } catch (e) {
        // not read, not recorded, not locked: the next pass tries again
        run.fail(uuid, `read failed (${why(e)})`, e)
        continue
      }
      // closed and draft elections have nothing to freeze and nothing to reopen later
      if (deriveLifecycle(election) !== 'open' || election.voting_ends_at === null) continue
      const payload: ElectionPayload = { endsAt: election.voting_ends_at, remainingMs: Math.max(Date.parse(election.voting_ends_at) - nowMs(ctx), 0) }
      // record FIRST: the election is not touched before the way back is on file
      let item: KarenzItemRow
      try {
        item = await ctx.items.upsert({ kind: ELECTION_ITEM_KIND, externalId: uuid, state: 'recorded', payload })
      } catch (e) {
        run.fail(uuid, `could not record (${why(e)})`, e)
        continue
      }
      await lockElection(ctx, run, port, item)
    }
    run.done()
  }
}

function restore(port: HeliosPausePort): KarenzParticipant['restore'] {
  return async (ctx) => {
    const run = new Run(ctx)
    const pending = new Set<ItemState>(['recorded', 'lock_failed', 'locked', 'unlock_failed'])
    for (const item of (await ctx.items.list(ELECTION_ITEM_KIND)).filter((i) => pending.has(i.state))) {
      const uuid = item.externalId
      const payload = payloadOf(item)
      if (!payload) {
        run.fail(uuid, 'item without a recorded end date')
        continue
      }
      // never locked: the pause may not have happened at all, so an election that ended by itself is not ours to reopen
      const neverLocked = item.state === 'recorded' || item.state === 'lock_failed'
      let election: HeliosElection
      try {
        election = await HeliosClient.getElection(uuid)
      } catch (e) {
        // nothing was written yet: the item keeps its state (a never-locked item must not turn into unlock_failed) and the next pass reads again
        run.fail(uuid, `read failed (${why(e)})`, e)
        if (!neverLocked) await run.set(item, 'unlock_failed', `read failed (${why(e)})`)
        continue
      }
      try {
        // still open: the lock never happened (or was lifted by hand); closed with its own end date: it ran out by itself
        if (deriveLifecycle(election) === 'open' || (neverLocked && !lockApplied(election, payload))) {
          await run.set(item, 'restored')
          continue
        }
        // at least one second: "now plus nothing" would read as closed again at once
        const r = await port.unlock(uuid, Math.max(payload.remainingMs, 1000))
        if (!r.ok) {
          run.fail(uuid, `unlock refused (${r.reason.slice(0, 60)})`)
          await run.set(item, 'unlock_failed', `unlock refused (${r.reason.slice(0, 60)})`)
          continue
        }
        if (deriveLifecycle(await HeliosClient.getElection(uuid)) !== 'open') {
          run.fail(uuid, 'still closed after the unlock')
          await run.set(item, 'unlock_failed', 'still closed after the unlock')
          continue
        }
        await run.set(item, 'restored')
      } catch (e) {
        // the unlock was attempted (or its read-back failed): the election is, or may be, locked
        run.fail(uuid, `unlock failed (${why(e)})`, e)
        await run.set(item, 'unlock_failed', `unlock failed (${why(e)})`)
      }
    }

    // elections the final step archived come back with the module
    const archived = (await ctx.items.list(ELECTION_ARCHIVE_ITEM_KIND)).filter((i) => i.state === 'recorded' || i.state === 'kept')
    if (archived.length > 0) {
      try {
        await ElectionDb.unarchiveForKarenz(archived.map((i) => i.externalId))
        for (const item of archived) await run.set(item, 'restored')
      } catch (e) {
        run.fail('archive', `could not un-archive (${why(e)})`, e)
      }
    }
    run.done()
  }
}

/** The ids of the elections the sealed copy has a line for. Throws when the copy cannot be opened: nothing is archived then. */
async function sealedElectionIds(ctx: KarenzContext): Promise<Set<string>> {
  const recordId = await retainedRecordIdFor(ctx.tenant.db, ctx.karenzId, ELECTION_RESULTS_EXTRACTOR_ID)
  if (!recordId) return new Set()
  return new Set((await openLines(ctx.tenant.db, ctx.tenant.id, recordId)).map((l) => l.id))
}

function finalize(): KarenzParticipant['finalize'] {
  return async (ctx, opts) => {
    const sealed = await sealedElectionIds(ctx)
    const toArchive = (await trackedUuids()).filter((u) => sealed.has(u))
    if (toArchive.length === 0 || opts.dryRun) return { deleted: { elections: toArchive.length } }
    // on file first: a restore un-archives exactly these
    const items: KarenzItemRow[] = []
    for (const uuid of toArchive) items.push(await ctx.items.upsert({ kind: ELECTION_ARCHIVE_ITEM_KIND, externalId: uuid, state: 'recorded', detail: 'to archive' }))
    const n = await ElectionDb.archiveForKarenz(toArchive)
    for (const item of items) await ctx.items.setState(item.itemId, 'kept', 'archived after the sealed result')
    return { deleted: { elections: n } }
  }
}

/** The participant over a given pause port (tests pass a fake). */
export function createElectionsKarenz(port: HeliosPausePort): KarenzParticipant {
  return { catalogueId: 'elections', switchOff: switchOff(port), restore: restore(port), finalize: finalize() }
}

/** The one pause port of this process: the participant and the switch-off guard registration both read it. */
export const electionsPausePort: HeliosPausePort = heliosPause()

export const electionsKarenz: KarenzParticipant = createElectionsKarenz(electionsPausePort)

/**
 * RC-ELE: one line per closed tracked election, the name, the end of voting and the published result.
 * No voter list: electorates follow RC-GOV-SECRET and are not copied; `persons` stays empty.
 */
export const electionResultsExtractor: RetentionExtractor = {
  id: ELECTION_RESULTS_EXTRACTOR_ID,
  catalogueId: 'elections',
  retentionClass: 'RC-ELE',
  async *extract(ctx) {
    // an election the participant paused (or may have paused) reads as closed because of us, not because it ended: it is not
    // a closed election of the council. One that is `restored` is not such an election: it ran out by itself or was reopened.
    const mayBePaused = new Set<ItemState>(['recorded', 'lock_failed', 'locked', 'unlock_failed'])
    const pausedByUs = new Set((await ctx.items.list(ELECTION_ITEM_KIND)).filter((i) => mayBePaused.has(i.state)).map((i) => i.externalId))
    for (const uuid of await trackedUuids()) {
      if (pausedByUs.has(uuid)) continue
      // an election that cannot be read fails the extraction: a copy without it would let the final day archive it unsealed
      // (an election Helios no longer knows is skipped: it has no sealed line, so the final day never archives it)
      const election = await readElectionOrGone(uuid)
      if (election === null || deriveLifecycle(election) !== 'closed') continue
      let result: unknown = null
      try {
        result = await HeliosClient.getResult(uuid)
      } catch (e) {
        // closed but not tallied: there is no result to keep yet
        if (!isGone(e)) throw e
      }
      yield { id: uuid, data: { name: election.name, votingEndsAt: election.voting_ends_at, result }, persons: [] }
    }
  },
}

/** Reason shown to the council while an election runs and Helios cannot pause it. */
export const ELECTION_RUNNING_REASON = 'Laufende Wahlen können nicht pausiert werden. Das Modul kann erst abgeschaltet werden, wenn keine Wahl mehr läuft.'

/**
 * Registered whenever the pause port cannot pause (`!canPause`): switching elections off while an election is open
 * would leave it running in Helios with nobody able to freeze it. A Helios that cannot be read throws, and
 * the guard registry then refuses (fail closed).
 */
export const electionsSwitchOffGuard: SwitchOffGuard = (tenant) =>
  runWithTenant(tenant, async () => {
    for (const uuid of await trackedUuids()) {
      const election = await readElectionOrGone(uuid)
      if (election !== null && deriveLifecycle(election) === 'open') return ELECTION_RUNNING_REASON
    }
    return null
  })
