import { writable, derived } from 'svelte/store'
import type { MatrixMessage } from '$lib/server/messages/matrix-client'

export type { MatrixMessage }

export interface RoomState {
  roomId: string
  name: string
  unreadCount: number
  lastMessageTs: number
  messages: MatrixMessage[]
  nextBatch?: string
  // TASK-009 lane B (row 16, FLOW-MSG-001): true when GET /api/messages/rooms
  // marked this room via the admin bot's org.gremion.room.archived read
  // (room-admin.ts getRoomArchiveMarker). Absent/false = active. The
  // /messages page (row 15) moves archived rooms into a separate "Archiv"
  // section and disables the composer for them.
  archived?: boolean
}

// Keyed by roomId
export const roomStore = writable<Record<string, RoomState>>({})

// Total unread count across all rooms (used by top bar notification badge)
export const totalUnread = derived(
  roomStore,
  ($rooms) => Object.values($rooms).reduce((sum, r) => sum + r.unreadCount, 0)
)

// Currently selected room
export const selectedRoomId = writable<string | null>(null)

// SSE connection status
export const syncStatus = writable<'connecting' | 'live' | 'error'>('connecting')
