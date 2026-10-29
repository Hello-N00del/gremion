import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

function getAuthSecret(): string {
  const s = process.env.AUTH_SECRET
  if (!s) throw new Error('AUTH_SECRET not set')
  return s
}

// Signed media URLs bind {mxc, roomId, exp}. The key is HKDF-derived from AUTH_SECRET with a
// purpose label, so the session-signing secret itself never keys these MACs.
const MEDIA_URL_TTL_SECONDS = 15 * 60
const MEDIA_KEY_INFO = 'gremion/messaging/media-url/v1'

function mediaKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', getAuthSecret(), '', MEDIA_KEY_INFO, 32))
}

export function signMedia(mxcUri: string, roomId: string, exp: number): string {
  return createHmac('sha256', mediaKey()).update(`${mxcUri}\n${roomId}\n${exp}`).digest('hex')
}

export function verifyMedia(mxcUri: string, roomId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false
  const expected = Buffer.from(signMedia(mxcUri, roomId, exp), 'hex')
  const given = Buffer.from(sig, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** The proxy download URL for one mxc in one room, signed and time-limited. */
export function mediaUrl(roomId: string, mxcUri: string): string {
  const exp = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SECONDS
  const sig = signMedia(mxcUri, roomId, exp)
  return `/api/messages/rooms/${encodeURIComponent(roomId)}/media?mxc=${encodeURIComponent(mxcUri)}&exp=${exp}&sig=${sig}`
}
