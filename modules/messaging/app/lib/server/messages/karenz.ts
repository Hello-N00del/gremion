// src/lib/server/messages/karenz.ts
// Module Karenz (phase 2, Task 15): the messaging participant.
//
// Switch-off: every org unit's chat room (the provisioning ledger row 'matrix' that names a room, whatever
// its status: a failed member sync leaves the external id on the live room) is
// archived through the same code path as the admin archive (read-only, restorable, the power levels
// it overwrites are kept in the archive marker). Restore: the rooms come back exactly as they were.
// Final day: the rooms the Karenz archived are deleted at the homeserver (block + purge), except the
// meeting-linked rooms (alias localpart `meeting-<eventId>`, created by /api/video/meeting-room),
// which stay until the end of the meeting retention (RC-MSG-LINK) and are never archived or deleted.
//
// Everything here is idempotent (the pass runs again after a crash) and processes ALL rooms before it
// fails: a failure is reported as a KarenzPartialError whose labels carry the org unit id only, never a
// room name, a room id or an alias. A room an admin archived BEFORE the switch-off has no ledger row,
// is never recorded and therefore never restored or deleted by the Karenz.
import { getMatrixClient } from './matrix-client'
import { getSynapseAdmin } from './synapse-admin'
import {
  getRoomArchiveMarker, unarchiveRoom, archiveRoom, resolveMatrixError, MatrixUnavailableError, RoomNotFoundError,
} from './admin/room-admin'
import { getOrgUnit, listOrgUnits } from '$lib/server/governance/org-units-db'
import { getResource } from '$lib/server/governance/provisioning/ledger'
import { writeAuditEntry } from '$lib/server/audit-db'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'
import {
  KarenzPartialError,
  type DeletionItem, type KarenzContext, type KarenzParticipant, type RetainedItem,
} from '$lib/server/module-karenz/participants'
import type { ItemState, KarenzItemRow } from '$lib/server/module-karenz/store'

/** The audit actor of every action the Karenz takes (accepted by audit_log_user_id_uuid_chk). */
const ACTOR = 'karenz-service'
const ROOM = 'room'
/** The retention class that keeps a meeting-linked room (catalogue: RC-MSG-LINK). */
const MEETING_LINK_CLASS = 'RC-MSG-LINK'

/** Item states from which a room still has work in switchOff / restore / finalize. */
const SWITCH_OFF_PENDING = new Set<string>(['recorded', 'lock_failed'])
const RESTORE_DONE = new Set<string>(['kept', 'restored', 'gone', 'deleted'])

/** `#meeting-<eventId>:server`: the alias of a room created for a calendar meeting. */
function isMeetingAlias(alias: string | null | undefined): boolean {
  return typeof alias === 'string' && /^#meeting-[^:]+:/.test(alias)
}

function unitOf(item: KarenzItemRow): string | null {
  const p = item.payload
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const id = (p as { unitId?: unknown }).unitId
    if (typeof id === 'string' && id !== '') return id
  }
  return null
}

/** A label for the operator log that names the unit, never the room. */
function unitLabel(unitId: string | null): string {
  return `unit ${unitId ?? 'unknown'}`
}

/** What an error may tell the settings page: its class, never its text (texts carry ids and urls). */
function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : 'Error'
}

/** The full error goes to the server log only (the homeserver client's errors are plain `Error`s whose
 *  message carries the HTTP status: the class alone cannot tell a permission problem from an outage).
 *  The unit is named by id; the settings page never sees this. */
function logServerSide(what: string, unitId: string | null, err: unknown): void {
  console.error(`[karenz/messaging] ${what}`, { unitId, err })
}

/** True only when the admin API positively answers "no such room". Never throws: a failing check is "not known". */
async function roomIsGone(roomId: string): Promise<boolean> {
  try {
    return (await getSynapseAdmin().getRoomDetails(roomId)) === null
  } catch {
    return false
  }
}

interface HomeserverRoom { room_id: string; creator?: string; canonical_alias?: string | null }

async function homeserverRooms(): Promise<Map<string, HomeserverRoom>> {
  const all = await getSynapseAdmin().listRooms()
  return new Map(all.map((r) => [r.room_id, r]))
}

/** The ledger rooms of this tenant: every org unit whose matrix row names a room. The row's STATUS does
 *  not matter: a transient member-sync error marks the row failed but leaves the external id on the
 *  live room, and archiveRoom itself only needs the external id. */
async function ledgerRooms(): Promise<{ unitId: string; roomId: string }[]> {
  const units = await listOrgUnits()
  const rows = await Promise.all(units.map((unit) => getResource(unit.id, 'matrix')))
  const out: { unitId: string; roomId: string }[] = []
  units.forEach((unit, i) => {
    const externalId = rows[i]?.external_id
    if (externalId) out.push({ unitId: unit.id, roomId: externalId })
  })
  return out
}

/** Bookkeeping inside a catch path: a failing write (the store throws when the item no longer exists)
 *  must not abort the loop, or the rooms after it would never be processed. Reports whether it was written. */
async function trySetState(ctx: KarenzContext, item: KarenzItemRow, state: ItemState, detail?: string): Promise<boolean> {
  try {
    await ctx.items.setState(item.itemId, state, detail)
    return true
  } catch (err) {
    logServerSide('item state could not be recorded', unitOf(item), err)
    return false
  }
}

/** Meeting-linked rooms that no ledger row owns: rooms the admin bot created with a meeting alias. */
function unownedMeetingRooms(rooms: Map<string, HomeserverRoom>, owned: Set<string>): string[] {
  const bot = getMatrixClient().getAdminBotUserId()
  const out: string[] = []
  for (const r of rooms.values()) {
    if (owned.has(r.room_id)) continue
    if (isMeetingAlias(r.canonical_alias) && bot !== '' && r.creator === bot) out.push(r.room_id)
  }
  return out
}

async function switchOff(ctx: KarenzContext): Promise<void> {
  const rooms = await homeserverRooms()
  const candidates = await ledgerRooms()

  // 1. record first (an upsert never undoes what an earlier pass did to the item), so a crash
  //    between the archive and the bookkeeping is found again.
  for (const c of candidates) {
    const meeting = isMeetingAlias(rooms.get(c.roomId)?.canonical_alias)
    await ctx.items.upsert({
      kind: ROOM, externalId: c.roomId, state: meeting ? 'kept' : 'recorded', payload: { unitId: c.unitId },
      ...(meeting ? { detail: MEETING_LINK_CLASS } : {}),
    })
  }
  for (const roomId of unownedMeetingRooms(rooms, new Set(candidates.map((c) => c.roomId)))) {
    await ctx.items.upsert({ kind: ROOM, externalId: roomId, state: 'kept', detail: MEETING_LINK_CLASS })
  }

  // 2. archive what is recorded; one failing room never stops the others.
  const failures: string[] = []
  for (const item of await ctx.items.list(ROOM)) {
    if (!SWITCH_OFF_PENDING.has(item.state)) continue
    const unitId = unitOf(item)
    if (unitId === null) continue // not one of ours
    try {
      const resource = await getResource(unitId, 'matrix')
      if (resource?.external_id === item.externalId) {
        await archiveRoom(unitId, { userId: ACTOR })
      } else if ((await getRoomArchiveMarker(item.externalId, { recordedUnitId: unitId }))?.org_unit_id !== unitId) {
        // Not attached to its unit and not archived by us. "Gone" needs positive evidence: the homeserver
        // says the room does not exist, or the unit's ledger names a DIFFERENT room. Anything else is a
        // live room the Karenz could not archive: it fails the step (retried) and says so.
        if (await roomIsGone(item.externalId)) {
          await ctx.items.setState(item.itemId, 'gone', 'room no longer exists at the homeserver')
          continue
        }
        if (resource?.external_id) {
          await ctx.items.setState(item.itemId, 'gone', 'unit is attached to another room')
          continue
        }
        failures.push(unitLabel(unitId))
        ctx.log(`messaging: ${unitLabel(unitId)} has a room that is neither attached nor archived, nothing archived`)
        await ctx.items.setState(item.itemId, 'lock_failed', 'room is neither attached to its unit nor archived')
        continue
      } // else: an earlier pass archived it and died before the bookkeeping
      await ctx.items.setState(item.itemId, 'locked')
    } catch (err) {
      // A purged room answers the client API with 403 (not 404), so a failure may only mean "gone":
      // the admin API is the one that tells.
      if (await roomIsGone(item.externalId)) {
        if (!(await trySetState(ctx, item, 'gone', 'room no longer exists at the homeserver'))) failures.push(unitLabel(unitId))
        continue
      }
      failures.push(unitLabel(unitId))
      ctx.log(`messaging: archive failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
      logServerSide('archive failed', unitId, err)
      await trySetState(ctx, item, 'lock_failed', `archive failed (${errorClass(err)})`)
    }
  }
  if (failures.length > 0) throw new KarenzPartialError(failures)
}

/** Why a RoomNotFoundError from unarchiveRoom means "nothing to restore" (the item ends as kept), or null
 *  when it does not: a locked room whose unit still exists but whose marker is missing stays a failure. */
async function whyNothingToRestore(item: KarenzItemRow, unitId: string): Promise<string | null> {
  try {
    if ((await getOrgUnit(unitId)) === null) return 'the org unit no longer exists, the room stays archived'
  } catch {
    return null // not known: stay a failure and be retried
  }
  // The archive never completed for this room (lock_failed, recorded): there is nothing to undo.
  return SWITCH_OFF_PENDING.has(item.state) ? 'the room was never archived, nothing to restore' : null
}

async function restore(ctx: KarenzContext): Promise<void> {
  const failures: string[] = []
  for (const item of await ctx.items.list(ROOM)) {
    if (RESTORE_DONE.has(item.state)) continue
    const unitId = unitOf(item)
    if (unitId === null) continue
    try {
      const { aliasRestored, priorGuessed } = await unarchiveRoom(unitId, item.externalId, { userId: ACTOR, recordedByCaller: true })
      if (!aliasRestored) ctx.log(`messaging: ${unitLabel(unitId)} restored without its alias (another room holds it)`)
      if (priorGuessed) ctx.log(`messaging: ${unitLabel(unitId)} restored with default permissions (the archive stored none)`)
      await ctx.items.setState(item.itemId, 'restored')
    } catch (err) {
      // Nothing left to restore is a terminal fact, not a failure that every later pass would repeat
      // (a failed item blocks the next switch-off and raises an error event each time).
      const nothingToRestore = err instanceof RoomNotFoundError ? await whyNothingToRestore(item, unitId) : null
      if (nothingToRestore !== null) {
        ctx.log(`messaging: ${unitLabel(unitId)}: ${nothingToRestore}`)
        if (!(await trySetState(ctx, item, 'kept', nothingToRestore))) failures.push(unitLabel(unitId))
        continue
      }
      // A room that is gone at the homeserver cannot come back: that is a fact, not a failure. The
      // client API answers a purged room with 403 (not 404), so the admin API decides, whatever the error was.
      if (await roomIsGone(item.externalId)) {
        if (!(await trySetState(ctx, item, 'gone', 'room no longer exists at the homeserver'))) failures.push(unitLabel(unitId))
        continue
      }
      failures.push(unitLabel(unitId))
      ctx.log(`messaging: restore failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
      logServerSide('restore failed', unitId, err)
      await trySetState(ctx, item, 'unlock_failed', `unarchive failed (${errorClass(err)})`)
    }
  }
  if (failures.length > 0) throw new KarenzPartialError(failures)
}

async function finalize(ctx: KarenzContext, opts: { dryRun: boolean }): Promise<{ deleted: Record<string, number> }> {
  let rooms = 0
  const failures: string[] = []
  for (const item of await ctx.items.list(ROOM)) {
    if (RESTORE_DONE.has(item.state)) continue
    const unitId = unitOf(item)
    if (unitId === null) continue
    try {
      if (item.state !== 'locked') {
        // recorded / lock_failed / unlock_failed: the archive never finished, so nothing may be deleted
        if (!opts.dryRun) failures.push(unitLabel(unitId)) // a preview only counts, it does not fail
        ctx.log(`messaging: ${unitLabel(unitId)} was not archived (${item.state}), nothing deleted`)
        continue
      }
      const details = await getSynapseAdmin().getRoomDetails(item.externalId)
      if (details === null) { // already gone at the homeserver
        // nothing left to delete here, so it adds nothing to the count. The audit trail still gets its
        // entry: an earlier pass may have purged the room and died before writing its own.
        if (!opts.dryRun) {
          await writeAuditEntry({ userId: ACTOR, field: 'messages.room.delete', oldValue: null, newValue: `${unitId}:${item.externalId}:ok-already-gone` })
          await ctx.items.setState(item.itemId, 'deleted', 'room no longer exists at the homeserver')
        }
        continue
      }
      if (isMeetingAlias(typeof details.canonical_alias === 'string' ? details.canonical_alias : null)) {
        if (!opts.dryRun) await ctx.items.setState(item.itemId, 'kept', MEETING_LINK_CLASS)
        continue
      }
      // Only a room the admin bot archived for THIS unit (the one trusted marker chokepoint) is deleted.
      const marker = await getRoomArchiveMarker(item.externalId, { recordedUnitId: unitId })
      if (!marker || marker.org_unit_id !== unitId) {
        // Never deleted, but never silent either: the Karenz locked this room itself, so a missing or
        // untrusted marker means the deletion did not happen. The item stays locked, so every pass reports it.
        ctx.log(`messaging: ${unitLabel(unitId)} has no trusted archive marker, nothing deleted`)
        if (!opts.dryRun) failures.push(unitLabel(unitId)) // a preview only counts, it does not fail
        continue
      }
      if (opts.dryRun) { rooms++; continue }
      await removeRoom(unitId, item.externalId)
      await ctx.items.setState(item.itemId, 'deleted')
      rooms++
    } catch (err) {
      failures.push(unitLabel(unitId))
      ctx.log(`messaging: final deletion failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
      logServerSide('final deletion failed', unitId, err)
    }
  }
  if (failures.length > 0) throw new KarenzPartialError(failures)
  return { deleted: { rooms } }
}

/** Block + purge at the homeserver, with the audit trail the admin delete writes. */
async function removeRoom(unitId: string, roomId: string): Promise<void> {
  try {
    await getSynapseAdmin().deleteRoom(roomId)
  } catch (err) {
    // The audit write must not replace the error being reported (a database outage would hide the homeserver's).
    try {
      await writeAuditEntry({ userId: ACTOR, field: 'messages.room.delete', oldValue: null, newValue: `${unitId}:${roomId}:failed` })
    } catch (auditErr) {
      logServerSide('final deletion: the failure audit entry could not be written', unitId, auditErr)
    }
    throw resolveMatrixError(err) === 'unavailable' ? new MatrixUnavailableError('homeserver unavailable', err) : err
  }
  await writeAuditEntry({ userId: ACTOR, field: 'messages.room.delete', oldValue: null, newValue: `${unitId}:${roomId}:ok` })
}

async function describe(tenant: TenantContext): Promise<{ deletes: DeletionItem[]; retained: RetainedItem[] }> {
  // The ledger, the org units and the homeserver clients resolve the tenant from the ambient context.
  return runWithTenant(tenant, describeForTenant)
}

async function describeForTenant(): Promise<{ deletes: DeletionItem[]; retained: RetainedItem[] }> {
  const rooms = await homeserverRooms()
  const candidates = await ledgerRooms()
  const archivable = candidates.filter((c) => !isMeetingAlias(rooms.get(c.roomId)?.canonical_alias)).length
  const meeting = candidates.length - archivable + unownedMeetingRooms(rooms, new Set(candidates.map((c) => c.roomId))).length
  const deletes: DeletionItem[] = archivable > 0 ? [{ label: 'Chat-Räume', count: archivable }] : []
  const retained: RetainedItem[] = meeting > 0
    ? [{
      label: 'Räume mit Terminbezug bleiben bis zum Ende der Sitzungsfrist',
      count: meeting,
      retentionClass: MEETING_LINK_CLASS,
    }]
    : []
  return { deletes, retained }
}

export const messagingKarenz: KarenzParticipant = {
  catalogueId: 'messaging',
  switchOff,
  restore,
  finalize,
  describe,
}
