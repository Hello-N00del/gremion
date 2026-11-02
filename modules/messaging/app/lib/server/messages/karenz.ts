// src/lib/server/messages/karenz.ts
// Module Karenz (phase 2, Task 15): the messaging participant.
//
// Switch-off: every org unit's chat room (the provisioning ledger row 'matrix' in state ok) is
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
  getRoomArchiveMarker, RoomNotFoundError, unarchiveRoom, archiveRoom, resolveMatrixError,
} from './admin/room-admin'
import { listOrgUnits } from '$lib/server/governance/org-units-db'
import { getResource } from '$lib/server/governance/provisioning/ledger'
import { writeAuditEntry } from '$lib/server/audit-db'
import {
  KarenzPartialError,
  type DeletionItem, type KarenzContext, type KarenzParticipant, type RetainedItem,
} from '$lib/server/module-karenz/participants'
import type { KarenzItemRow } from '$lib/server/module-karenz/store'

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

interface HomeserverRoom { room_id: string; creator?: string; canonical_alias?: string | null }

async function homeserverRooms(): Promise<Map<string, HomeserverRoom>> {
  const all = await getSynapseAdmin().listRooms()
  return new Map(all.map((r) => [r.room_id, r]))
}

/** The ledger rooms of this tenant (org units with a matrix row in state ok). */
async function ledgerRooms(): Promise<{ unitId: string; roomId: string }[]> {
  const out: { unitId: string; roomId: string }[] = []
  for (const unit of await listOrgUnits()) {
    const r = await getResource(unit.id, 'matrix')
    if (r?.status === 'ok' && r.external_id) out.push({ unitId: unit.id, roomId: r.external_id })
  }
  return out
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
      if (resource?.status === 'ok' && resource.external_id === item.externalId) {
        await archiveRoom(unitId, { userId: ACTOR })
      } else if ((await getRoomArchiveMarker(item.externalId))?.org_unit_id !== unitId) {
        // neither attached nor archived by us: the room is no longer there to archive
        await ctx.items.setState(item.itemId, 'gone', 'room no longer attached to its unit')
        continue
      } // else: an earlier pass archived it and died before the bookkeeping
      await ctx.items.setState(item.itemId, 'locked')
    } catch (err) {
      failures.push(unitLabel(unitId))
      ctx.log(`messaging: archive failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
      await ctx.items.setState(item.itemId, 'lock_failed', `archive failed (${errorClass(err)})`)
    }
  }
  if (failures.length > 0) throw new KarenzPartialError(failures)
}

async function restore(ctx: KarenzContext): Promise<void> {
  const failures: string[] = []
  for (const item of await ctx.items.list(ROOM)) {
    if (RESTORE_DONE.has(item.state)) continue
    const unitId = unitOf(item)
    if (unitId === null) continue
    try {
      await unarchiveRoom(unitId, item.externalId, { userId: ACTOR })
      await ctx.items.setState(item.itemId, 'restored')
    } catch (err) {
      try {
        // A room that is gone at the homeserver cannot come back: that is a fact, not a failure.
        if (err instanceof RoomNotFoundError && (await getSynapseAdmin().getRoomDetails(item.externalId)) === null) {
          await ctx.items.setState(item.itemId, 'gone', 'room no longer exists at the homeserver')
          continue
        }
      } catch {
        // the existence check failed too: report the original failure below
      }
      failures.push(unitLabel(unitId))
      ctx.log(`messaging: restore failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
      await ctx.items.setState(item.itemId, 'unlock_failed', `unarchive failed (${errorClass(err)})`)
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
        failures.push(unitLabel(unitId))
        ctx.log(`messaging: ${unitLabel(unitId)} was not archived (${item.state}), nothing deleted`)
        continue
      }
      const details = await getSynapseAdmin().getRoomDetails(item.externalId)
      if (details === null) { // already gone at the homeserver
        // nothing left to delete here, so it adds nothing to the count
        if (!opts.dryRun) await ctx.items.setState(item.itemId, 'deleted', 'room no longer exists at the homeserver')
        continue
      }
      if (isMeetingAlias(typeof details.canonical_alias === 'string' ? details.canonical_alias : null)) {
        if (!opts.dryRun) await ctx.items.setState(item.itemId, 'kept', MEETING_LINK_CLASS)
        continue
      }
      // Only a room the admin bot archived for THIS unit (the one trusted marker chokepoint) is deleted.
      const marker = await getRoomArchiveMarker(item.externalId)
      if (!marker || marker.org_unit_id !== unitId) {
        if (!opts.dryRun) await ctx.items.setState(item.itemId, 'kept', 'no trusted archive marker')
        continue
      }
      if (opts.dryRun) { rooms++; continue }
      await removeRoom(unitId, item.externalId)
      await ctx.items.setState(item.itemId, 'deleted')
      rooms++
    } catch (err) {
      failures.push(unitLabel(unitId))
      ctx.log(`messaging: final deletion failed for ${unitLabel(unitId)}: ${errorClass(err)}`)
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
    await writeAuditEntry({ userId: ACTOR, field: 'messages.room.delete', oldValue: null, newValue: `${unitId}:${roomId}:failed` })
    throw resolveMatrixError(err) === 'unavailable' ? new Error('homeserver unavailable') : err
  }
  await writeAuditEntry({ userId: ACTOR, field: 'messages.room.delete', oldValue: null, newValue: `${unitId}:${roomId}:ok` })
}

async function describe(): Promise<{ deletes: DeletionItem[]; retained: RetainedItem[] }> {
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
