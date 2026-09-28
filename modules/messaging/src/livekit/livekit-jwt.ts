// services/messages/src/livekit/livekit-jwt.ts
// Leaf-side helpers for the Element-Call SFU JWT (MSC4195) flow.
//
// NOTE: the live SFU-token routes (routes/livekit/jwt/{sfu/get,get_token}) are
// EXEMPT from this extraction (boundary/rules.ts no-messages-route-to-matrix-client
// sourceExempt) — the full openid-token verification + room-membership check +
// mint stays on the kernel's in-process livekit-jwt helper by design. These leaf
// helpers (CORS preflight, the MSC4195 response envelope, the membership-error
// type) are STAGED for a future SFU extraction; the mint itself reuses
// mintLivekitToken from ./livekit-client.

/** #257-1: a non-member SFU request is an authorization failure (403), not a
 *  gateway error (502). */
export class RoomMembershipError extends Error {
  constructor(message = 'not a member of the room') {
    super(message)
    this.name = 'RoomMembershipError'
  }
}

/** The fromWidget SFU-token request body (element-call → get_token / sfu/get). */
export interface SfuRequest {
  room: string
  openid_token?: {
    access_token?: string
    matrix_server_name?: string
  }
  device_id?: string
}

/** CORS headers for the SFU-token endpoints (element-call is a cross-origin
 *  widget). Mirrors the kernel livekit-jwt corsHeaders(). */
export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

/** MSC4195 SFU-token success envelope: access_token + token_type + expires_in. */
export function sfuTokenResponse(jwt: string, expiresIn = 3600): {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
} {
  return { access_token: jwt, token_type: 'Bearer', expires_in: expiresIn }
}
