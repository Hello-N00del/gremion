// services/messages/src/operations.ts
// The messages+video leaf's route-parity CONTRACT: exactly one internal
// `/api/v1/*` operation per messages+video API route the kernel serves today.
//
// This is the extraction surface. It is grep-verified against the kernel routes
// under gremion-ui/src/routes/api/{messages,video,auth/matrix-*} and locked by
// test/route-parity.test.ts so the extraction can never silently drop (or
// duplicate) a route. When the kernel MESSAGES_BACKEND seam is wired at the
// cutover, the ServiceMessagesClient calls these leaf endpoints; the per-op
// Matrix/LiveKit/Synapse forwarding is filled in then (see server.ts).
//
// Every leaf endpoint is POST (internal RPC-style, like the files leaf's
// /api/v1/<op>): the kernel client translates its public GET/POST/PUT/DELETE
// route into the corresponding internal POST.

export interface Operation {
  /** Stable op id (also used in logs/spans as messages.acl.<op>). */
  readonly op: string
  /** Internal leaf endpoint path. Always POST. */
  readonly path: string
  /** The leaf endpoint verb (always POST for internal RPC). */
  readonly method: 'POST'
  /** The kernel public route this op extracts (documentation + parity anchor). */
  readonly kernelRoute: string
  /** The kernel public route's HTTP method. */
  readonly kernelMethod: 'GET' | 'POST' | 'PUT' | 'DELETE'
}

export const OPERATIONS: readonly Operation[] = [
  // ── Messages (Matrix Client-Server API, per-request user Matrix token) ─────────
  { op: 'messages.sync', path: '/api/v1/messages/sync', method: 'POST', kernelRoute: '/api/messages/sync', kernelMethod: 'GET' },
  { op: 'messages.rooms', path: '/api/v1/messages/rooms', method: 'POST', kernelRoute: '/api/messages/rooms', kernelMethod: 'GET' },
  { op: 'messages.list', path: '/api/v1/messages/list', method: 'POST', kernelRoute: '/api/messages/rooms/[roomId]/messages', kernelMethod: 'GET' },
  { op: 'messages.send', path: '/api/v1/messages/send', method: 'POST', kernelRoute: '/api/messages/rooms/[roomId]/messages', kernelMethod: 'POST' },
  { op: 'messages.media.download', path: '/api/v1/messages/media/download', method: 'POST', kernelRoute: '/api/messages/rooms/[roomId]/media', kernelMethod: 'GET' },
  { op: 'messages.media.upload', path: '/api/v1/messages/media/upload', method: 'POST', kernelRoute: '/api/messages/rooms/[roomId]/media', kernelMethod: 'POST' },
  { op: 'messages.read', path: '/api/v1/messages/read', method: 'POST', kernelRoute: '/api/messages/rooms/[roomId]/read', kernelMethod: 'POST' },
  { op: 'messages.typing', path: '/api/v1/messages/typing', method: 'POST', kernelRoute: '/api/messages/rooms/[roomId]/typing', kernelMethod: 'PUT' },

  // ── Video (LiveKit + Element Call / MatrixRTC widget bridge) ───────────────────
  { op: 'video.token', path: '/api/v1/video/token', method: 'POST', kernelRoute: '/api/video/token', kernelMethod: 'POST' },
  { op: 'video.meeting-room', path: '/api/v1/video/meeting-room', method: 'POST', kernelRoute: '/api/video/meeting-room', kernelMethod: 'POST' },
  { op: 'video.openid-token', path: '/api/v1/video/openid-token', method: 'POST', kernelRoute: '/api/video/openid-token', kernelMethod: 'GET' },
  { op: 'video.widget-action', path: '/api/v1/video/widget-action', method: 'POST', kernelRoute: '/api/video/matrix-widget-action', kernelMethod: 'POST' },

  // ── Matrix auth (Keycloak JWT → Synapse token exchange + device admin) ─────────
  { op: 'auth.matrix-token', path: '/api/v1/auth/matrix-token', method: 'POST', kernelRoute: '/api/auth/matrix-token', kernelMethod: 'GET' },
  { op: 'auth.matrix-device', path: '/api/v1/auth/matrix-device', method: 'POST', kernelRoute: '/api/auth/matrix-device', kernelMethod: 'DELETE' },
]

/** Path → Operation lookup for the router. */
export const OPERATION_BY_PATH: ReadonlyMap<string, Operation> = new Map(
  OPERATIONS.map((o) => [o.path, o]),
)
