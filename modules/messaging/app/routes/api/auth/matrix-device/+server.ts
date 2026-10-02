import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { getMessagesBackend } from '$lib/server/messages/backend'

/**
 * DELETE /api/auth/matrix-device
 *
 * Lets the authenticated mobile client delete its own Synapse device via the
 * Synapse admin API. Called during OLM key recovery when the local OLM state
 * (SQLite DB) is deleted but the old device's identity key is already committed
 * in Synapse — Synapse rejects re-uploads with a different ed25519 key for the
 * same device_id. Deleting the device lets the next JWT login create a fresh
 * device session with no prior key commitments.
 *
 * Body: { deviceId: string }
 * Auth: Bearer <keycloak-access-token> — validated in hooks.server.ts.
 *
 * The Synapse admin device-delete goes through the MessagesBackendPort seam
 * (backend.synapse().deleteDevice), NOT a direct fetch: this keeps the
 * SYNAPSE_ADMIN_TOKEN in the messages backend (the leaf, in service mode) so the
 * kernel route never touches the admin credential. Flag-OFF the inprocess client
 * delegates to the same Synapse admin DELETE this route used inline before, so
 * behavior stays byte-identical (the 502 error message is preserved verbatim).
 */
export const DELETE: RequestHandler = async ({ request, locals }) => {
  const user = locals.user
  if (!user) {
    return json({ success: false, error: 'Unauthenticated' }, { status: 401 })
  }

  const body = await request.json().catch(() => null) as { deviceId?: string } | null
  const deviceId = body?.deviceId
  if (!deviceId) {
    return json({ success: false, error: 'deviceId required' }, { status: 400 })
  }

  // localpart → the backend forms @{localpart}:{serverName} (per-tenant in-process,
  // or the leaf's SYNAPSE_SERVER_NAME in service mode) — same as the pre-seam route.
  const localpart = user.preferredUsername ?? user.id

  try {
    await getMessagesBackend().synapse().deleteDevice(localpart, deviceId)
    return json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return json({ success: false, error: msg }, { status: 502 })
  }
}
