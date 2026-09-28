// services/messages/src/matrix/matrix-creds.ts
// Leaf-side Matrix-creds resolver: given the Synapse base URL + a user's Matrix
// access token, resolve their Matrix user id via /account/whoami. SOFT — any
// failure yields empty creds (never throws), mirroring the kernel matrix-creds
// contract the video/token route depends on. Forwarding building block for the
// MESSAGES_BACKEND=service cutover.

export interface MatrixCreds {
  userId: string
  accessToken: string
}

/** Resolve `{ userId, accessToken }` from a Matrix access token via whoami.
 *  Returns `{ userId: '', accessToken: '' }` on any failure (never throws). */
export async function resolveMatrixCreds(baseUrl: string, matrixToken: string): Promise<MatrixCreds> {
  try {
    const base = baseUrl.replace(/\/$/, '')
    const res = await fetch(`${base}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${matrixToken}` },
    })
    if (res.ok) {
      const data = (await res.json()) as { user_id?: string }
      if (data.user_id) return { userId: data.user_id, accessToken: matrixToken }
    }
  } catch {
    // Fall through — Matrix creds unavailable, caller decides how to degrade.
  }
  return { userId: '', accessToken: '' }
}
