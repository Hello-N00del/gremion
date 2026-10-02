// v5 Task 4.6 — three outer chrome layouts for the Element Call frame
// (prototype screens-v4.jsx:128-238): `active` = floating PiP corner card,
// `expanded` = docked side-panel on the right, `fullscreen` = full-bleed.
// `idle` = no call. The middle `expanded` state is new in v5.
export type CallStatus = 'idle' | 'active' | 'expanded' | 'fullscreen'

export interface PipPosition {
  /** Distance from the right edge of the viewport in px */
  x: number
  /** Distance from the bottom edge of the viewport in px */
  y: number
}

export interface CallStore {
  status: CallStatus
  /** Livekit room name (e.g. stura-room-abc123) */
  roomName: string
  /** Human-readable display name (Matrix room display name or peer name) */
  roomDisplayName: string
  /** Matrix room ID or peer Matrix user ID — used to build Element Call URL */
  matrixRoomId: string
  participantCount: number
  pipPosition: PipPosition
}

export const callStore: CallStore = $state({
  status: 'idle',
  roomName: '',
  roomDisplayName: '',
  matrixRoomId: '',
  participantCount: 0,
  pipPosition: { x: 24, y: 24 },
})

/** Initiate a room call */
export function startRoomCall(matrixRoomId: string, displayName: string): void {
  callStore.status = 'active'
  callStore.matrixRoomId = matrixRoomId
  callStore.roomDisplayName = displayName
  callStore.roomName = ''
  callStore.participantCount = 0
}

/** Initiate a DM call */
export function startDmCall(peerMatrixId: string, peerDisplayName: string): void {
  callStore.status = 'active'
  callStore.matrixRoomId = peerMatrixId
  callStore.roomDisplayName = peerDisplayName
  callStore.roomName = ''
  callStore.participantCount = 0
}

export function endCall(): void {
  callStore.status = 'idle'
  callStore.roomName = ''
  callStore.roomDisplayName = ''
  callStore.matrixRoomId = ''
  callStore.participantCount = 0
}

export function setFullscreen(on: boolean): void {
  if (callStore.status === 'idle') return
  callStore.status = on ? 'fullscreen' : 'active'
}

/**
 * v5 Task 4.6 — toggle the docked side-panel ("expanded") layout. No-op while
 * idle; turning it off returns to the floating PiP card. Keeping this distinct
 * from setFullscreen lets the chrome offer PiP → expanded → fullscreen as three
 * explicit steps (matching the prototype's three layouts).
 */
export function setExpanded(on: boolean): void {
  if (callStore.status === 'idle') return
  callStore.status = on ? 'expanded' : 'active'
}
