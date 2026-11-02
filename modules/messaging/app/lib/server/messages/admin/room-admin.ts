// src/lib/server/messages/admin/room-admin.ts
//
// FLOW-MSG-001 (TASK-009 lane B): create/rename/archive/delete/overview for the
// admin room surface ("Verwaltung -> Räume"). Deliberately a MODULE-internal
// file, not a leaf service: room administration is control-plane work, in the
// same process as the provisioning worker, so it drives the in-process
// matrix-client/synapse-admin clients directly (like
// messages/register.server.ts does) rather than going through
// MessagesBackendPort. The `no-messages-route-to-matrix-client` boundary rule
// still holds — routes import ONLY this module, never the clients (rooms-plan.md
// S2.3, R2).
//
// Create/archive/delete all go through the kernel provisioning ledger
// (attachSubsystem/releaseSubsystem), the SAME lock+ledger path the
// provisioning worker uses — a double create is impossible by construction,
// and a released subsystem is never recreated by the worker's own tick
// (rooms-plan.md S2.1).
import { getMatrixClient } from '../matrix-client'
import { getSynapseAdmin } from '../synapse-admin'
import { aliasLocalpart } from '../provisioning/matrix-subsystem'
import {
  applyReadOnlyPowerLevels, capturePrior, readPowerLevels, restorePowerLevels, sanitizePrior,
  type ArchivePriorPowerLevels, type PowerLevelsContent,
} from './archive-power-levels'
import { serviceEnv } from '$lib/server/env/service-env'
import { getOrgUnit, listOrgUnits, setSubsystemWanted, type OrgUnit } from '$lib/server/governance/org-units-db'
import { enqueueResources, getResource, markResourceOk } from '$lib/server/governance/provisioning/ledger'
import { withUnitLock } from '$lib/server/governance/provisioning/mutex'
import { attachSubsystem, releaseSubsystem } from '$lib/server/governance/provisioning/orchestrator'
import { getDb } from '$lib/server/db'
import type { ProvisioningReport } from '$lib/server/governance/provisioning/types'
import { writeAuditEntry } from '$lib/server/audit-db'

/** Thrown when a Matrix/Synapse call fails for a TRANSPORT reason (unreachable,
 *  timed out, or a 502/503/504 from the homeserver) — the caller (route layer)
 *  maps this to 503, distinct from an ordinary application/upstream error (502). */
export class MatrixUnavailableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'MatrixUnavailableError'
  }
}

/** A room already exists for this org unit (ledger row 'ok' with an external_id). */
export class RoomConflictError extends Error {
  constructor(public readonly roomId: string) {
    super(`room already exists: ${roomId}`)
    this.name = 'RoomConflictError'
  }
}

/** The org unit, or the room for it, does not exist (or the roomId given does
 *  not belong to this unit — the route layer maps this to 404, which also
 *  covers a cross-tenant probe: another tenant's roomId never matches). */
export class RoomNotFoundError extends Error {
  constructor(message = 'room not found') {
    super(message)
    this.name = 'RoomNotFoundError'
  }
}

export type MatrixErrorKind = 'unavailable' | 'upstream'

const UNAVAILABLE_PATTERN = /ECONNREFUSED|ETIMEDOUT|getaddrinfo|abort(ed)?|\b50[234]\b/i

/** T14: classify an error as a Matrix-transport outage (PRD-DEP-002: shown as a
 *  banner separate from ordinary Gremion errors, 503) vs an application/upstream
 *  error from Synapse itself (502). Deliberately string-pattern based — every
 *  call site here throws a plain Error whose message carries the status/errno,
 *  not a structured error object (matching matrix-client.ts's existing style). */
export function resolveMatrixError(err: unknown): MatrixErrorKind {
  const msg = err instanceof Error ? err.message : String(err)
  return UNAVAILABLE_PATTERN.test(msg) ? 'unavailable' : 'upstream'
}

// R3 (rooms-plan.md, known/flagged-not-fixed bug): this MUST resolve the server
// name the exact same way registerProvisioningSubsystem does for the matrix
// subsystem (serviceEnv('SYNAPSE_SERVER_NAME'), not a per-tenant-correct
// value) — the canonical alias this reads to DELETE on archive was built with
// that same value at create time. Using a different value here would silently
// miss the real alias on a non-default tenant.
function serverName(): string {
  return serviceEnv('SYNAPSE_SERVER_NAME') ?? 'localhost'
}

function canonicalAlias(unitName: string): string {
  return `#${aliasLocalpart(unitName)}:${serverName()}`
}

/** #stura-archiv-<slug>-<yyyymmddhhmm> — a fresh alias per archive so re-archiving
 *  (after a completed-then-somehow-reopened cycle) never collides with a prior one. */
function freshArchiveAlias(unitName: string): string {
  const slug = aliasLocalpart(unitName).replace(/^stura-/, '')
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  return `#stura-archiv-${slug}-${ts}:${serverName()}`
}

export interface CreateRoomResult {
  roomId: string
  report: ProvisioningReport
}

/** POST /api/messages/rooms (route layer, next unit). CouncilAdmin/ITAdmin. */
export async function createRoom(
  unitId: string, opts: { name?: string; userId: string }
): Promise<CreateRoomResult> {
  const unit = await getOrgUnit(unitId)
  if (!unit) throw new RoomNotFoundError(`org unit not found: ${unitId}`)

  // 409 before ANY Matrix call — a double create is also impossible by
  // construction inside attachSubsystem (the ledger's 'ok' row short-circuits
  // ensureResource), but checking here avoids even the DB round-trip into it.
  const existing = await getResource(unitId, 'matrix')
  if (existing?.status === 'ok' && existing.external_id) {
    throw new RoomConflictError(existing.external_id)
  }

  const report = await attachSubsystem(unitId, 'matrix')
  const matrixResult = report.subsystems.find((s: { subsystem: string }) => s.subsystem === 'matrix')

  if (matrixResult?.status !== 'ok') {
    await writeAuditEntry({
      userId: opts.userId, field: 'messages.room.create',
      oldValue: null, newValue: `${unitId}::failed`,
    })
    const kind = resolveMatrixError(new Error(matrixResult?.error ?? ''))
    if (kind === 'unavailable') {
      throw new MatrixUnavailableError(matrixResult?.error ?? 'Matrix unreachable while creating room')
    }
    throw new Error(matrixResult?.error ?? 'matrix provisioning failed')
  }

  // LOW (r1-kernel-nav-roomsB2/r2-rooms-B3): a concurrent archiveRoom/
  // deleteRoom on this same unit between attachSubsystem's return above and
  // this re-fetch can leave the ledger row absent even though matrixResult
  // just reported 'ok'. A stacked non-null assertion would turn that narrow
  // race into an unhandled TypeError; guard it explicitly instead so the
  // caller gets a typed, branchable error (mapped to 404 at the route layer)
  // rather than a raw crash.
  const resource = await getResource(unitId, 'matrix')
  if (!resource?.external_id) {
    throw new RoomNotFoundError(
      `matrix provisioning reported ok for unit ${unitId} but its ledger row is gone (concurrent archive/delete?)`
    )
  }
  const roomId = resource.external_id

  // A custom name is applied AFTER provisioning (the alias always stays
  // derived from the unit name — rooms-plan.md S2.1).
  if (opts.name && opts.name !== unit.name) {
    await getMatrixClient().setRoomState(roomId, 'm.room.name', '', { name: opts.name })
  }

  await writeAuditEntry({
    userId: opts.userId, field: 'messages.room.create',
    oldValue: null, newValue: `${unitId}:${roomId}:ok`,
  })
  return { roomId, report }
}

/** PATCH /api/messages/rooms/[roomId] (route layer, next unit). */
export async function renameRoom(
  unitId: string, opts: { name?: string; topic?: string; userId: string }
): Promise<void> {
  const resource = await getResource(unitId, 'matrix')
  if (!resource?.external_id) throw new RoomNotFoundError(`no active room for unit ${unitId}`)
  const roomId = resource.external_id
  const mc = getMatrixClient()

  try {
    if (opts.name !== undefined) await mc.setRoomState(roomId, 'm.room.name', '', { name: opts.name })
    if (opts.topic !== undefined) await mc.setRoomState(roomId, 'm.room.topic', '', { topic: opts.topic })
  } catch (err) {
    if (resolveMatrixError(err) === 'unavailable') {
      throw new MatrixUnavailableError((err as Error).message, err)
    }
    throw err
  }

  await writeAuditEntry({
    userId: opts.userId, field: 'messages.room.rename',
    oldValue: null, newValue: `${unitId}:${roomId}:ok`,
  })
}

/** rooms-plan.md S2.2: the Matrix-side archive sequence, run in this exact
 *  order (asserted by T10) — the durable marker first (survives even if a
 *  later step fails), then read-only power levels, then the alias swap,
 *  then (TASK-009 fu1 defect 1) making the fresh archive alias canonical.
 *  Every step is idempotent, so re-running this after a partial failure (a
 *  prior DB detach that did not commit) is safe. Members deliberately stay
 *  joined — FLOW [A] "Verlauf bleibt lesbar" — no membership call here. */
async function archiveMatrixSide(unitId: string, unitName: string, roomId: string): Promise<void> {
  const mc = getMatrixClient()
  // Karenz (Task 15): the marker also carries the power levels this archive is about to
  // overwrite, so unarchiveRoom can put them back exactly. A retry after a partial archive
  // finds the room ALREADY read-only, so the first attempt's marker (when it is a trusted
  // one with a prior) wins: reading the levels again would store the archived ones.
  const existing = await getRoomArchiveMarker(roomId)
  const keptPrior = sanitizePrior(existing?.prior)
  let current: PowerLevelsContent | undefined
  let prior = keptPrior
  if (!prior) {
    current = await readPowerLevels(roomId)
    prior = capturePrior(current)
  }
  const keptAlias = existing?.org_unit_id === unitId && typeof existing.archive_alias === 'string' && existing.archive_alias.startsWith('#stura-archiv-')
    ? existing.archive_alias : null
  const archiveAlias = keptAlias ?? freshArchiveAlias(unitName)
  await mc.setRoomState(roomId, ROOM_ARCHIVE_MARKER_TYPE, '', {
    org_unit_id: unitId, archived_at: (keptPrior && typeof existing?.archived_at === 'string' && existing.archived_at) || new Date().toISOString(), prior,
    archive_alias: archiveAlias,
  })
  await applyReadOnlyPowerLevels(roomId, current)

  // MEDIUM (round-1 deferred, r1-kernel-nav-roomsB2): canonicalAlias is
  // derived from the unit's CURRENT name, not from what the alias actually
  // points at right now. A rename collision (this unit's new name hashes to
  // an aliasLocalpart some OTHER unit's room already claims) or a stale
  // read would otherwise delete a DIFFERENT unit's live canonical alias.
  // Resolve the alias first and only delete it when it still points at
  // THIS room; a resolve failure or a mismatch skips the delete (logged)
  // rather than risking someone else's alias — the fresh archive alias
  // below still gets set either way, so the room is still reachable.
  const alias = canonicalAlias(unitName)
  const resolvedRoomId = await mc.getRoomIdByAlias(alias).catch(() => null)
  if (resolvedRoomId === roomId) {
    await mc.deleteRoomAlias(alias)
  } else {
    console.error('[room-admin] archiveMatrixSide: canonical alias does not resolve to the room being archived, skipping delete', {
      unitId, roomId, alias, resolvedRoomId,
    })
  }

  // DEFECT 1 (live e2e): the fresh archive alias used to be set ONLY in the
  // room directory (putRoomAlias) and never made canonical
  // (room_stats_state.canonical_alias stayed NULL, confirmed on Synapse's own
  // DB for both archived probe rooms) — findArchivedRooms' old search-based
  // detection depended on exactly that field, so it silently found nothing.
  // Detection no longer depends on this (see findArchivedRooms above), but a
  // human opening the room, or an admin using Synapse's own search, should
  // still be able to find it by alias — so this is set anyway, purely for
  // discoverability, never as the trust boundary. Computed ONCE and reused
  // for both the directory PUT and this state event — freshArchiveAlias()
  // embeds a timestamp, so calling it a second time would mint a DIFFERENT
  // alias than the one just placed in the directory.
  // Placed AFTER applyReadOnlyPowerLevels (not before): that call already
  // grants the bot PL100 via make_room_admin when the room predates it being
  // admin (a legacy room/demo seed) — this reuses that same grant rather
  // than needing its own separate forbidden-then-retry path.
  //
  // The alias was chosen up front and is in the marker (above): a retry after a partial archive reuses
  // it instead of minting a second one, which would stay behind in the directory and still resolve to
  // the room after a Karenz restore. Only when it already points at this room is the PUT skipped
  // (a directory PUT of an existing alias is a 409 at the homeserver).
  if (!keptAlias || (await mc.getRoomIdByAlias(archiveAlias).catch(() => null)) !== roomId) {
    await mc.putRoomAlias(archiveAlias, roomId)
  }
  await mc.setRoomState(roomId, 'm.room.canonical_alias', '', { alias: archiveAlias })
}

/** POST /api/messages/rooms/[roomId]/archive (route layer, next unit).
 *  CouncilAdmin/ITAdmin. Returns the archived room's id. */
export async function archiveRoom(unitId: string, opts: { userId: string }): Promise<string> {
  const unit = await getOrgUnit(unitId)
  if (!unit) throw new RoomNotFoundError(`org unit not found: ${unitId}`)
  const resource = await getResource(unitId, 'matrix')
  if (!resource?.external_id) throw new RoomNotFoundError(`no active room for unit ${unitId}`)

  let roomId: string | null
  try {
    // releaseSubsystem runs the teardown callback FIRST (under the unit lock),
    // then detaches the ledger row only after it succeeds (orchestrator.ts) —
    // this is what makes "Matrix first, DB second" (S2.1) hold.
    roomId = await releaseSubsystem(unitId, 'matrix', async (externalId) => {
      if (!externalId) return
      await archiveMatrixSide(unitId, unit.name, externalId)
    })
  } catch (err) {
    await writeAuditEntry({
      userId: opts.userId, field: 'messages.room.archive',
      oldValue: unit.name, newValue: `${unitId}:${resource.external_id}:failed`,
    })
    if (resolveMatrixError(err) === 'unavailable') {
      throw new MatrixUnavailableError((err as Error).message, err)
    }
    throw err
  }

  await writeAuditEntry({
    userId: opts.userId, field: 'messages.room.archive',
    oldValue: unit.name, newValue: `${unitId}:${roomId}:ok`,
  })
  return roomId as string
}

/** The Matrix side of the restore, every step idempotent: power levels back from the marker's
 *  prior, the unit's canonical alias back (never taken over from ANOTHER room), the archive alias
 *  removed. */
async function unarchiveMatrixSide(unit: OrgUnit, roomId: string, prior: ArchivePriorPowerLevels | null): Promise<void> {
  const mc = getMatrixClient()
  const canonical = canonicalAlias(unit.name)
  const holder = await mc.getRoomIdByAlias(canonical)
  // The alias is never taken over from ANOTHER room (archiveMatrixSide tolerates the same collision):
  // the restore still completes - writable room, ledger re-attached - and the room keeps its archive
  // alias as its canonical one, so it stays reachable.
  const aliasTaken = holder !== null && holder !== undefined && holder !== roomId
  if (aliasTaken) {
    console.error('[room-admin] unarchiveRoom: the unit alias belongs to another room, restoring without it', {
      unitId: unit.id, roomId, alias: canonical, holder,
    })
  }
  await restorePowerLevels(roomId, prior)
  if (aliasTaken) return
  if (!holder) await mc.putRoomAlias(canonical, roomId)

  const current = (await mc.getRoomState(roomId, 'm.room.canonical_alias')) as { alias?: unknown } | null
  const archiveAlias = typeof current?.alias === 'string' && current.alias.startsWith('#stura-archiv-') ? current.alias : null
  // The archive alias is removed BEFORE the canonical alias is overwritten: the room's current canonical
  // alias is the only place it is found, so a failure after the overwrite would leave it behind for good.
  // A retry after a failure here still sees the archive alias as canonical and finishes the job.
  // Only delete an archive alias that still points at THIS room (as archiveMatrixSide does for the canonical one).
  if (archiveAlias && (await mc.getRoomIdByAlias(archiveAlias)) === roomId) await mc.deleteRoomAlias(archiveAlias)
  await mc.setRoomState(roomId, 'm.room.canonical_alias', '', { alias: canonical })
}

/** Karenz restore (Task 15): the inverse of archiveRoom. Brings an archived room of `unitId` back:
 *  writable again (the power levels the archive stored in its marker), the unit's alias back (unless
 *  another room holds it: that alias is never taken over and the restore still completes), the
 *  ledger re-attached, then - LAST, so an interrupted restore is simply run again - the marker is
 *  overwritten with { unarchived_at } (a state event cannot be deleted; getRoomArchiveMarker reads
 *  a marker without org_unit_id as "not archived"). A room that is already the unit's active room
 *  is a no-op. A RoomConflictError means the unit already has another active room; the Matrix side is
 *  not touched then. */
export async function unarchiveRoom(unitId: string, roomId: string, opts: { userId: string }): Promise<void> {
  const unit = await getOrgUnit(unitId)
  if (!unit) throw new RoomNotFoundError(`org unit not found: ${unitId}`)

  return withUnitLock(unitId, async () => {
    const marker = await getRoomArchiveMarker(roomId)
    const resource = await getResource(unitId, 'matrix')
    if (!marker || marker.org_unit_id !== unitId) {
      if (resource?.status === 'ok' && resource.external_id === roomId) return // already active
      throw new RoomNotFoundError(`room ${roomId} is not an archived Gremion room of unit ${unitId}`)
    }
    if (resource?.status === 'ok' && resource.external_id && resource.external_id !== roomId) {
      throw new RoomConflictError(resource.external_id)
    }

    const prior = sanitizePrior(marker.prior)
    if (!prior) {
      // A room archived before the prior was stored: its levels are guessed from the createRoom defaults.
      console.warn('[room-admin] unarchiveRoom: marker carries no prior power levels, restoring the createRoom defaults', { unitId, roomId })
    }
    try {
      await unarchiveMatrixSide(unit, roomId, prior)
      await getDb().begin(async (tx) => {
        await enqueueResources(tx, unitId, ['matrix'])
        await setSubsystemWanted(tx, unitId, 'matrix', true)
      })
      await markResourceOk(unitId, 'matrix', roomId)
      await getMatrixClient().setRoomState(roomId, ROOM_ARCHIVE_MARKER_TYPE, '', { unarchived_at: new Date().toISOString() })
    } catch (err) {
      // A failing audit write (a database outage is the likely reason the ledger step failed) must not
      // replace the error that is being reported.
      try {
        await writeAuditEntry({
          userId: opts.userId, field: 'messages.room.unarchive',
          oldValue: unit.name, newValue: `${unitId}:${roomId}:failed`,
        })
      } catch (auditErr) {
        console.error('[room-admin] unarchiveRoom: the failure audit entry could not be written', { unitId, roomId, auditErr })
      }
      if (resolveMatrixError(err) === 'unavailable') {
        throw new MatrixUnavailableError(err instanceof Error ? err.message : String(err), err)
      }
      throw err
    }
    await writeAuditEntry({
      userId: opts.userId, field: 'messages.room.unarchive',
      oldValue: unit.name, newValue: `${unitId}:${roomId}:ok`,
    })
  })
}

/** DELETE /api/messages/rooms/[roomId]?orgUnitId= (route layer, next unit).
 *  ITAdmin only. Reuses synapseAdmin.deleteRoom (block+purge), then detaches.
 *  An archived room is authorized only when its marker's org_unit_id matches
 *  unitId AND that unit still exists in this tenant's DB — otherwise 404, so
 *  only Gremion-managed rooms can ever be deleted through this path. */
export async function deleteRoom(
  unitId: string, roomId: string, opts: { userId: string }
): Promise<void> {
  const resource = await getResource(unitId, 'matrix')
  if (resource?.external_id === roomId) {
    try {
      await releaseSubsystem(unitId, 'matrix', async (externalId) => {
        if (externalId) await getSynapseAdmin().deleteRoom(externalId)
      })
    } catch (err) {
      // Parity with createRoom/archiveRoom: a failed delete attempt still
      // gets an audit trail, and a transport-class failure is classified the
      // same way (MatrixUnavailableError -> 503) rather than propagating a
      // raw, unclassified error.
      await writeAuditEntry({
        userId: opts.userId, field: 'messages.room.delete',
        oldValue: null, newValue: `${unitId}:${roomId}:failed`,
      })
      if (resolveMatrixError(err) === 'unavailable') {
        throw new MatrixUnavailableError((err as Error).message, err)
      }
      throw err
    }
    await writeAuditEntry({
      userId: opts.userId, field: 'messages.room.delete',
      oldValue: null, newValue: `${unitId}:${roomId}:ok`,
    })
    return
  }

  const unit = await getOrgUnit(unitId)
  if (!unit) throw new RoomNotFoundError(`org unit not found: ${unitId}`)
  // Verifier FIX 1: the ONE marker chokepoint — it only trusts a marker the
  // admin bot wrote in a room the admin bot created (a user-forged marker in
  // a user-created room resolves to null here, so it is a 404, never a purge).
  const marker = await getRoomArchiveMarker(roomId)
  if (!marker || marker.org_unit_id !== unitId) {
    throw new RoomNotFoundError(`room ${roomId} is not a Gremion-managed room for unit ${unitId}`)
  }

  try {
    await getSynapseAdmin().deleteRoom(roomId)
  } catch (err) {
    await writeAuditEntry({
      userId: opts.userId, field: 'messages.room.delete',
      oldValue: null, newValue: `${unitId}:${roomId}:failed`,
    })
    if (resolveMatrixError(err) === 'unavailable') {
      throw new MatrixUnavailableError((err as Error).message, err)
    }
    throw err
  }
  await writeAuditEntry({
    userId: opts.userId, field: 'messages.room.delete',
    oldValue: null, newValue: `${unitId}:${roomId}:ok`,
  })
}

export type RoomOverviewState = 'leer' | 'wird_angelegt' | 'fehler' | 'aktiv' | 'archiviert' | 'fehler_lesen'

export interface RoomOverviewEntry {
  unitId: string
  unitName: string
  state: RoomOverviewState
  roomId?: string
  lastError?: string
}

export interface RoomOverview {
  matrix: 'reachable' | 'unreachable'
  units: RoomOverviewEntry[]
}

// FLOW-MSG-001 (TASK-009 fu1 defect 1): bounded-concurrency map, used so
// findArchivedRooms reads at most ARCHIVE_MARKER_CONCURRENCY rooms' markers
// at once rather than firing one GET pair per candidate room simultaneously
// (a server with hundreds of Gremion-managed rooms would otherwise open
// hundreds of concurrent connections to Synapse for a single overview load).
const ARCHIVE_MARKER_CONCURRENCY = 8

async function mapWithConcurrency<T, R>(
  items: readonly T[], limit: number, fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length })
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** B3(c): archived-room cross-reference for listOverview. A released ledger
 *  row is DELETED entirely (S2.1 "Matrix first, DB second" — releaseSubsystem
 *  detaches the row), so getResource alone cannot tell "never had a room"
 *  (leer) apart from "archived" — only the Matrix-side alias survives (S2.2
 *  step 3: #stura-archiv-<slug>-<yyyymmddhhmm>).
 *
 *  TASK-009 fu1 defect 1: this used to search_term-search for
 *  'stura-archiv-', but Synapse's search_term only matches a room's NAME,
 *  CANONICAL_ALIAS or ROOM_ID (element-hq synapse docs/admin_api/rooms.md) —
 *  archiveMatrixSide's fresh archive alias is a plain directory alias, never
 *  made canonical, so search-based detection silently found nothing and
 *  every archived unit degraded to 'leer' (an admin could then create a
 *  duplicate room for it). The durable archive marker
 *  (ROOM_ARCHIVE_MARKER_TYPE, validated by getRoomArchiveMarker — sender AND
 *  m.room.create sender both the admin bot) is the actual source of truth;
 *  it was never the problem. Detection now scans every room via
 *  listRooms() (paginated, no search_term) and keeps only those whose
 *  `creator` is the admin bot (a scan-size optimization only — the marker
 *  chokepoint below is what actually decides trust) before reading each
 *  candidate's marker, bounded to ARCHIVE_MARKER_CONCURRENCY at a time.
 *  Best-effort: any failure (listing or a single marker read) degrades to
 *  detecting nothing archived, so the overview still renders every unit's
 *  ledger-derived state (PRD-DEP-004) instead of throwing. */
async function findArchivedRooms(): Promise<Map<string, { roomId: string; archivedAt?: string }>> {
  const byUnit = new Map<string, { roomId: string; archivedAt?: string }>()
  try {
    const bot = getMatrixClient().getAdminBotUserId()
    // LOW (TASK-009 fu1 round 2 verifier): an unconfigured admin bot user id
    // used to fall through the `Boolean(bot) && …` filter below silently —
    // every room dropped, zero candidates, empty map, no error, no log. That
    // is real and reachable (a misconfigured/unset env var), and it looks
    // identical to "no unit has ever been archived" in the operator-facing
    // overview. createRoom/makeRoomAdmin/getRoomArchiveMarker already fail
    // (loudly or via a null they explain) in this configuration, so this was
    // never a NEW way to end up admin-side broken — but it's still worth its
    // own explicit signal rather than degrading in silence.
    if (!bot) {
      console.error('[room-admin] findArchivedRooms: admin bot user id unconfigured, cannot detect archived rooms')
      return byUnit
    }
    const allRooms = await getSynapseAdmin().listRooms()
    const candidates = allRooms.filter((room) => room.creator === bot)
    // Markers are read with bounded concurrency (each independent of the
    // others), then merged sequentially so a genuine multi-archive collision
    // (LOW, r2-rooms-B3) can still be resolved deterministically by archivedAt.
    const markers = await mapWithConcurrency(candidates, ARCHIVE_MARKER_CONCURRENCY, async (room) => {
      const roomId = room.room_id
      if (!roomId) return null
      try {
        const marker = await getRoomArchiveMarker(roomId)
        return marker?.org_unit_id ? { roomId, marker } : null
      } catch (err) {
        // A single room's marker read failing is NOT "no archived rooms" —
        // log it so a genuine bug (as opposed to a real Matrix outage,
        // caught below) is distinguishable from "leer" in the admin overview.
        console.error('[room-admin] findArchivedRooms: getRoomArchiveMarker failed for room, skipping it', {
          roomId, error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    })
    for (const entry of markers) {
      if (!entry) continue
      const unitId = entry.marker.org_unit_id as string
      const existing = byUnit.get(unitId)
      // Deterministic pick when a unit has more than one archived room
      // (re-archived after a recreate cycle): keep the newest archivedAt
      // rather than whichever listing order happened to win.
      if (!existing || (entry.marker.archived_at ?? '') > (existing.archivedAt ?? '')) {
        byUnit.set(unitId, { roomId: entry.roomId, archivedAt: entry.marker.archived_at })
      }
    }
  } catch (err) {
    // Matrix listing unreachable/erroring — degrade to none-detected (see
    // above), but log it: a genuine listRooms bug must not look identical to
    // "no archived rooms exist" in the operator-facing overview.
    console.error('[room-admin] findArchivedRooms: listRooms failed, degrading to none-detected', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return byUnit
}

/** GET /messages/manage load (route layer, next unit). Never throws — every
 *  per-unit ledger read is caught individually, and Matrix reachability
 *  degrades to 'unreachable' via validateCredentials's own no-throw contract
 *  (PRD-DEP-004: the rest of the page/admin still works with Matrix down). The
 *  archived-room search only runs while Matrix is reachable, so an outage
 *  never adds extra failing calls on top of the already-degraded state. */
export async function listOverview(
  units: readonly Pick<OrgUnit, 'id' | 'name'>[]
): Promise<RoomOverview> {
  const matrixReachable = await getSynapseAdmin().validateCredentials().catch(() => false)
  const archivedByUnit = matrixReachable ? await findArchivedRooms() : new Map<string, { roomId: string; archivedAt?: string }>()

  // Parallel per-unit ledger reads (N+1 -> one round-trip batch, MEDIUM,
  // r1-kernel-nav-roomsB2): each read is independent of every other unit's.
  // A REJECTED read is logged and reported as its own distinct
  // 'fehler_lesen' state, never silently collapsed into 'leer' — a
  // transient DB error must not look identical to "this unit never had a
  // room" to the operator debugging the overview (MEDIUM, both reviews).
  const entries: RoomOverviewEntry[] = await Promise.all(
    units.map(async (unit) => {
      let resource: Awaited<ReturnType<typeof getResource>> | null = null
      let readFailed = false
      try {
        resource = await getResource(unit.id, 'matrix')
      } catch (err) {
        readFailed = true
        console.error('[room-admin] listOverview: getResource failed for unit, reporting fehler_lesen', {
          unitId: unit.id, error: err instanceof Error ? err.message : String(err),
        })
      }
      let state: RoomOverviewState
      let roomId: string | undefined
      let lastError: string | undefined
      if (readFailed) {
        state = 'fehler_lesen'
      } else if (resource?.status === 'ok' && resource.external_id) {
        state = 'aktiv'
        roomId = resource.external_id
      } else if (resource?.status === 'pending') {
        state = 'wird_angelegt'
      } else if (resource?.status === 'failed') {
        state = 'fehler'
        lastError = resource.last_error ?? undefined
      } else if (!resource) {
        // No ledger row at all — either never had a room (leer) or the row
        // was released on archive (S2.1 "Matrix first, DB second"), which
        // the archived-room cross-reference below can still detect.
        const archived = archivedByUnit.get(unit.id)
        if (archived) {
          state = 'archiviert'
          roomId = archived.roomId
        } else {
          state = 'leer'
        }
      } else {
        // MEDIUM (round-1 deferred, r2-rooms-B3): a ledger row DOES exist
        // here (resource is truthy) but matched none of the recognized
        // shapes above (e.g. status 'ok' with no external_id, or any other
        // unrecognized status value) — a genuine data-shape regression, not
        // "no room"/"archived". Silently falling through to the
        // archived-check branch used to make this indistinguishable from a
        // genuinely empty/archived unit in the operator-facing overview.
        state = 'fehler'
        lastError = `unrecognized ledger row shape (status: ${String(resource.status)})`
        console.error('[room-admin] listOverview: unit has a ledger row matching no recognized state, reporting fehler', {
          unitId: unit.id, status: resource.status, hasExternalId: Boolean(resource.external_id),
        })
      }
      return { unitId: unit.id, unitName: unit.name, state, roomId, lastError }
    })
  )
  return { matrix: matrixReachable ? 'reachable' : 'unreachable', units: entries }
}

/** Standalone Matrix-reachability probe (the overview's own reachability check
 *  factored out so a caller — e.g. a health/status widget — can use it alone). */
export async function probeMatrix(): Promise<boolean> {
  return getSynapseAdmin().validateCredentials()
}

export interface RoomArchiveMarker {
  org_unit_id?: string
  archived_at?: string
  /** Karenz (Task 15): the power levels the archive overwrote (see ArchivePriorPowerLevels). Raw Matrix
   *  state, NOT trusted: run it through sanitizePrior before reading a single field. */
  prior?: unknown
  /** The archive alias this archive minted (a retry reuses it; the restore removes it). */
  archive_alias?: string
  /** Set by unarchiveRoom on a marker without org_unit_id (a state event cannot be deleted). */
  unarchived_at?: string
}

export const ROOM_ARCHIVE_MARKER_TYPE = 'org.gremion.room.archived'

/** Reads the S2.2-step-1 durable archive marker (`org.gremion.room.archived`)
 *  off a room, as the admin bot (which stays joined/PL100 regardless of
 *  whether the calling browser user has joined) — so this works both for the
 *  admin-mutation routes (PATCH/DELETE/archive, row 10-12: 404 vs 409) and for
 *  the general GET /api/messages/rooms listing + first-login auto-join (row
 *  10), which must not join a user into an archived room.
 *
 *  SECURITY (TASK-009 verifier FIX 1) — this is the ONE chokepoint every
 *  marker consumer goes through (findArchivedRooms/listOverview,
 *  findUnitIdForRoom, deleteRoom's archived-room path, the room routes). Any
 *  signed-in user can mint a Matrix token, create their own room (PL100
 *  there), name it stura-archiv-x and set this state event naming a victim
 *  org unit. So the marker is trusted ONLY when both are true:
 *    - the marker event's `sender` is the admin bot (archiveMatrixSide writes
 *      it with the admin token), and
 *    - the room's `m.room.create` `sender` is the admin bot (every Gremion-
 *      managed room is created by MatrixClient.createRoom as the bot).
 *  Both are read as full events (?format=event, Synapse >= 1.124). Anything
 *  else returns null — "not archived, not Gremion-managed". A missing marker
 *  (404) is also null; a transport failure propagates so each caller keeps
 *  its own fail-closed/fail-open policy. */
export async function getRoomArchiveMarker(roomId: string): Promise<RoomArchiveMarker | null> {
  const mc = getMatrixClient()
  const bot = mc.getAdminBotUserId()
  const markerEvent = await mc.getRoomStateEvent(roomId, ROOM_ARCHIVE_MARKER_TYPE)
  if (!markerEvent) return null
  if (!bot || markerEvent.sender !== bot) {
    console.warn('[room-admin] getRoomArchiveMarker: ignoring an archive marker not sent by the admin bot', {
      roomId, sender: markerEvent.sender || null,
    })
    return null
  }
  const createEvent = await mc.getRoomStateEvent(roomId, 'm.room.create')
  if (!createEvent || createEvent.sender !== bot) {
    console.warn('[room-admin] getRoomArchiveMarker: ignoring an archive marker in a room the admin bot did not create', {
      roomId, creator: createEvent?.sender || null,
    })
    return null
  }
  const content = markerEvent.content
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null
  // A marker that names no org unit is an UNARCHIVED room (unarchiveRoom overwrites the
  // marker with { unarchived_at }): not archived, so the overview, auto-join and the
  // room routes treat the room as active again.
  const unitId = (content as RoomArchiveMarker).org_unit_id
  if (typeof unitId !== 'string' || unitId === '') return null
  return content as RoomArchiveMarker
}

/** TASK-009 lane B (row 15): reverse-lookup for the /messages Einstellungen
 *  panel — given an active room's roomId, find the org unit that owns it, so
 *  the panel's rename/archive/delete calls (which all take orgUnitId, not
 *  roomId alone — rows-plan.md S2.5) have something to send. O(units) ledger
 *  reads; only called from an admin-gated code path (never per member, per
 *  room-list load), so this is an acceptable cost for an occasional admin
 *  action rather than a hot path. Falls back to the archive marker so the
 *  panel also resolves an ALREADY-archived room's unit (e.g. re-opened from
 *  the Archiv section). Returns null if nothing matches (unknown/foreign room). */
export async function findUnitIdForRoom(roomId: string): Promise<string | null> {
  const units = await listOrgUnits()
  for (const unit of units) {
    const resource = await getResource(unit.id, 'matrix').catch(() => null)
    if (resource?.external_id === roomId) return unit.id
  }
  const marker = await getRoomArchiveMarker(roomId).catch(() => null)
  const markerUnitId = marker?.org_unit_id
  if (!markerUnitId) return null
  // LOW (house review, TASK-009 fix round 2): the archive marker is Matrix
  // room state, not this tenant's own DB — trusting org_unit_id off it
  // verbatim would resolve the Einstellungen panel onto a unit id that no
  // longer exists (or never did) in this tenant, the same unverified-input
  // gap deleteRoom already guards against for its own archived-room path.
  // Confirm the unit is one of THIS tenant's own before returning it;
  // otherwise report "unknown" (null), same as no match at all.
  const known = units.some((unit) => unit.id === markerUnitId)
  return known ? markerUnitId : null
}
