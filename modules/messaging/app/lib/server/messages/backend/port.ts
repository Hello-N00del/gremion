// gremion-ui/src/lib/server/messages/backend/port.ts
// Branch-by-abstraction seam for the messages+video (Matrix / LiveKit / Synapse)
// subsystem.
//
// MessagesBackendPort is the interface the messages+video API route handlers
// (routes/api/{messages,video,auth/matrix-token}) call once the seam is wired
// in. It exposes the kernel's existing Matrix / Synapse / LiveKit clients (and
// the shared resolveMatrixCreds helper) as accessors so the route handlers keep
// their exact per-request orchestration — the InprocessMessagesClient is a
// transparent delegate and behavior stays byte-identical to the pre-seam monolith
// (flag OFF). When MESSAGES_BACKEND=service (the HELD cutover) the same interface
// is fulfilled by the messages-service leaf over HTTP.
//
// The livekit/jwt SFU-token routes are NOT part of this seam (they stay on the
// in-process livekit-jwt helper, outside the extraction surface — see
// boundary/rules.ts no-messages-route-to-matrix-client sourceExempt).
//
// port.ts is a MODULE INTERNAL (not a route), so it may reference the kernel
// client types directly — the boundary rule only forbids ROUTE imports of the
// concrete clients. It re-exports the shared shapes so the routes + service
// client reference the seam, never the clients directly.

import type { RequestEvent } from '@sveltejs/kit'
import type { SyncResponse, MatrixMessage } from '../matrix-client'
import type { MintTokenOptions } from '../livekit-client'
import type { MatrixCreds } from '../matrix-creds'

export type { SyncResponse, MatrixMessage, MatrixRoom } from '../matrix-client'
export type { MintTokenOptions } from '../livekit-client'
export type { MatrixCreds } from '../matrix-creds'

/** The browser-CS-API subset of the kernel MatrixClient that the messages+video
 *  routes drive through the seam. Structural — the concrete MatrixClient (a
 *  superset) is assignable; the service twin implements exactly this set. */
export interface MatrixClientPort {
  /** Exchange a Keycloak access token for a Synapse access token (JWT login). */
  getMatrixToken(keycloakJwt: string, deviceId?: string): Promise<string>
  /** Long-poll /sync → the normalized SyncResponse. */
  sync(userToken: string, since?: string): Promise<SyncResponse>
  /** The caller's joined room ids. */
  getJoinedRooms(userToken: string): Promise<string[]>
  /** Per-room unread *message* counts (excludes membership invites). */
  unreadMessageCountsByRoom(userToken: string): Promise<Map<string, number>>
  /** Room message history (dir=b). */
  getMessages(userToken: string, roomId: string, from?: string): Promise<{ messages: MatrixMessage[]; end: string }>
  /** Send a message → the new event id. */
  sendMessage(userToken: string, roomId: string, content: { msgtype: string; body: string; url?: string }): Promise<string>
  /** Advance the user's read markers in a room. */
  setReadMarker(userToken: string, roomId: string, eventId: string): Promise<void>
  /** Set/clear the typing indicator for a user in a room. */
  sendTyping(userToken: string, roomId: string, userId: string, typing: boolean): Promise<void>
  /** Upload media as the user → the mxc:// URI. */
  uploadMedia(userToken: string, data: ArrayBuffer, mimeType: string, filename: string): Promise<string>
  /** Download media (admin token) → bytes + content type. */
  downloadMedia(mxcUri: string): Promise<{ data: ArrayBuffer; contentType: string }>
  /** Create (or idempotently adopt by alias) a room as the admin bot → roomId. */
  createRoom(name: string, topic: string, aliasLocalpart?: string): Promise<string>
  /** Invite a user to a room as the admin bot (idempotent). */
  inviteUser(roomId: string, userId: string): Promise<void>
  /** Join a room with the user's own token (idempotent). */
  joinRoom(userToken: string, roomIdOrAlias: string): Promise<void>
}

/** The Synapse-admin subset the messages+video routes drive through the seam. */
export interface SynapseAdminPort {
  /** Force-join a user to a room via the Synapse Admin API (idempotent). */
  forceJoinRoom(roomId: string, userId: string): Promise<void>
  /** #370: all server room ids via the Synapse Admin API. The matrix-token +
   *  messages/rooms routes call this to auto-join a fresh user to every room on
   *  first login. Folding it into the port keeps SYNAPSE_ADMIN_TOKEN in the backend
   *  (the leaf, in service mode) — the routes no longer fetch /_synapse/admin/v1/rooms
   *  (or reference the admin token) directly. Degrades to [] on any failure. */
  listAllRoomIds(): Promise<string[]>
  /** Delete the caller's OWN Synapse device via the Admin API (mobile OLM key
   *  recovery). The user id is `@${localpart}:${serverName}` (the backend resolves
   *  the server name — per-tenant in-process, or the leaf's SYNAPSE_SERVER_NAME in
   *  service mode). Throws on a non-2xx Synapse response, message = the Synapse
   *  error body's `error` (or `Synapse <status>`), which the route maps to a 502.
   *  This keeps SYNAPSE_ADMIN_TOKEN in the backend (the leaf, once cut over) — the
   *  route never touches the admin credential directly. */
  deleteDevice(localpart: string, deviceId: string): Promise<void>
  /** #257-1 (video parity): true iff `userId` is a confirmed member of `roomId`.
   *  The video/token route gates its room-call branch on this before minting a
   *  room-pinned LiveKit token — exactly as handleSfuRequest gates the SFU publish
   *  token — so an authed user can no longer obtain a join/eavesdrop token for a
   *  room they are not in. Fails CLOSED: any admin-API / leaf error yields false so
   *  a token is never minted on an unverifiable membership. In-process → the
   *  Synapse Admin members list; service → the leaf's video.meeting-room
   *  { isMember } multiplex. */
  isRoomMember(roomId: string, userId: string): Promise<boolean>
}

/** The LiveKit subset the video/token route drives through the seam. The two
 *  room-name helpers are pure (no secrets); only mintToken touches LiveKit keys. */
export interface LivekitPort {
  mintToken(opts: MintTokenOptions): Promise<string>
  roomNameFromMatrixId(matrixRoomId: string): string
  dmRoomName(userIdA: string, userIdB: string): string
}

export interface MessagesBackendPort {
  /**
   * Discriminant identifying which implementation is in use.
   * 'inprocess' = in-process kernel Matrix/LiveKit/Synapse clients (byte-identical
   * to the monolith); 'service' = HTTP ACL calls to the messages-service leaf.
   */
  readonly kind: 'inprocess' | 'service'

  /** The Matrix client-server API client (per-request user token). */
  matrix(): MatrixClientPort
  /** The Synapse admin client (server admin token). */
  synapse(): SynapseAdminPort
  /** The LiveKit token minter + room-name helpers. */
  livekit(): LivekitPort
  /** Resolve the caller's Matrix creds (userId + access token) from their session.
   *  SOFT: returns `{ userId: '', accessToken: '' }` on any failure (never throws). */
  resolveMatrixCreds(event: RequestEvent): Promise<MatrixCreds>
}
