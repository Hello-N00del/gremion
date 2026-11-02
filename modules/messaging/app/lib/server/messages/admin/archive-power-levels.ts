// src/lib/server/messages/admin/archive-power-levels.ts
//
// The power-level half of the room archive (rooms-plan.md S2.2 step 2) and of the Karenz restore
// (Module Karenz, Task 15): read the levels, capture the values the archive overwrites, close the
// room (read-only), and put the captured values back. Split out of room-admin.ts to keep that file
// under the size cap; room-admin.ts is the only importer.
import { getMatrixClient } from '../matrix-client'
import { getSynapseAdmin } from '../synapse-admin'

function isForbidden(err: unknown): boolean {
  return err instanceof Error && /\b403\b|M_FORBIDDEN/.test(err.message)
}

export interface PowerLevelsContent {
  events?: Record<string, number>
  events_default?: number
  invite?: number
  state_default?: number
  users?: Record<string, number>
  [key: string]: unknown
}

// The four RTC/call-member event types createRoom's power_level_content_override
// opens to PL0 (matrix-client.ts createRoom) — archive closes them back to 100
// alongside events_default/invite/state_default, so a former member cannot start
// or join a call, publish keys, or send any other event in a read-only room.
export const CALL_MEMBER_EVENT_TYPES: readonly string[] = [
  'org.matrix.msc4143.rtc.member',
  'org.matrix.msc3401.call.member',
  'm.call.member',
  'io.element.call.encryption_keys',
]

/** The power-level values the archive overwrites, stored in the archive marker so
 *  a Karenz restore (unarchiveRoom) puts the room back exactly as it was. Every
 *  field is optional: a value the room did not carry is simply absent. */
export interface ArchivePriorPowerLevels {
  events_default?: number
  invite?: number
  state_default?: number
  /** Only the call-member event types the archive closes (CALL_MEMBER_EVENT_TYPES). */
  events?: Record<string, number>
}

// The createRoom defaults (private_chat preset plus the PL0 call-member override of
// matrix-client.ts createRoom): what unarchiveRoom restores for a marker that carries no prior.
export const CREATE_ROOM_DEFAULTS = Object.freeze({ events_default: 0, invite: 0, state_default: 50, callMemberLevel: 0 })

/** Runs `fn`; on a forbidden answer grants the bot PL100 ONCE (S2.2 step 5 - a
 *  legacy room/demo seed where the bot is below PL100) and retries; a second
 *  failure propagates rather than looping. */
async function withBotAdminRetry<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isForbidden(err)) throw err
    await getSynapseAdmin().makeRoomAdmin(roomId, getMatrixClient().getAdminBotUserId())
    return await fn() // retry once; a second failure propagates untouched
  }
}

export async function readPowerLevels(roomId: string): Promise<PowerLevelsContent> {
  return withBotAdminRetry(roomId, async () =>
    ((await getMatrixClient().getRoomState(roomId, 'm.room.power_levels')) ?? {}) as PowerLevelsContent)
}

export function capturePrior(current: PowerLevelsContent): ArchivePriorPowerLevels {
  const prior: ArchivePriorPowerLevels = {}
  for (const key of ['events_default', 'invite', 'state_default'] as const) {
    if (typeof current[key] === 'number') prior[key] = current[key]
  }
  const events: Record<string, number> = {}
  for (const type of CALL_MEMBER_EVENT_TYPES) {
    const level = current.events?.[type]
    if (typeof level === 'number') events[type] = level
  }
  prior.events = events
  return prior
}

/** True when the levels are the ones applyReadOnlyPowerLevels writes (a room that is already archived). */
export function isReadOnlyLevels(levels: PowerLevelsContent): boolean {
  return levels.events_default === 100 && levels.invite === 100 && levels.state_default === 100
}

/** A prior read back from a marker is Matrix state anyone with PL could have shaped: keep only the numbers. */
export function sanitizePrior(raw: unknown): ArchivePriorPowerLevels | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const prior: ArchivePriorPowerLevels = {}
  for (const key of ['events_default', 'invite', 'state_default'] as const) {
    const v = r[key]
    if (typeof v === 'number') prior[key] = v
  }
  if (r.events && typeof r.events === 'object' && !Array.isArray(r.events)) {
    const events: Record<string, number> = {}
    for (const type of CALL_MEMBER_EVENT_TYPES) {
      const level = (r.events as Record<string, unknown>)[type]
      if (typeof level === 'number') events[type] = level
    }
    prior.events = events
  }
  return prior
}

/** rooms-plan.md S2.2 step 2: read-then-write m.room.power_levels, keeping the
 *  existing `users` map untouched. `current` is the read the caller already did
 *  (the archive reads first to store the prior); without it this reads itself.
 *  `current` serves the FIRST attempt only: when that write is forbidden, make_room_admin
 *  raises the bot's own level, and a retry must read the levels again - writing the stale
 *  `users` map would put the bot back below 100 in a room that now needs 100.
 *  Falls back to make_room_admin ONCE (see withBotAdminRetry). */
export async function applyReadOnlyPowerLevels(roomId: string, current?: PowerLevelsContent): Promise<void> {
  const mc = getMatrixClient()
  let preRead = current
  await withBotAdminRetry(roomId, async () => {
    const base = preRead ?? (((await mc.getRoomState(roomId, 'm.room.power_levels')) ?? {}) as PowerLevelsContent)
    preRead = undefined
    const events = { ...base.events }
    for (const type of CALL_MEMBER_EVENT_TYPES) events[type] = 100
    await mc.setRoomState(roomId, 'm.room.power_levels', '', {
      ...base, events, events_default: 100, invite: 100, state_default: 100,
    })
  })
}

/** The inverse of applyReadOnlyPowerLevels: the prior values from the marker, or the createRoom defaults. */
export async function restorePowerLevels(roomId: string, prior: ArchivePriorPowerLevels | null): Promise<void> {
  const mc = getMatrixClient()
  await withBotAdminRetry(roomId, async () => {
    const base = ((await mc.getRoomState(roomId, 'm.room.power_levels')) ?? {}) as PowerLevelsContent
    const events = { ...base.events }
    for (const type of CALL_MEMBER_EVENT_TYPES) {
      if (!prior) events[type] = CREATE_ROOM_DEFAULTS.callMemberLevel
      else {
        const level = prior.events?.[type]
        if (typeof level === 'number') events[type] = level
        else delete events[type] // the room did not carry this type before the archive
      }
    }
    await mc.setRoomState(roomId, 'm.room.power_levels', '', {
      ...base, events,
      events_default: prior?.events_default ?? CREATE_ROOM_DEFAULTS.events_default,
      invite: prior?.invite ?? CREATE_ROOM_DEFAULTS.invite,
      state_default: prior?.state_default ?? CREATE_ROOM_DEFAULTS.state_default,
    })
  })
}
