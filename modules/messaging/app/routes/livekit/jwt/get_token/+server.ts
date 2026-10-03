import { json } from '@sveltejs/kit'
import type { RequestHandler } from '@sveltejs/kit'
import { corsHeaders, handleSfuRequest, RoomMembershipError } from '$lib/server/messages/livekit-jwt'
import type { SfuRequest } from '$lib/server/messages/livekit-jwt'

export const OPTIONS: RequestHandler = () =>
  new Response(null, { status: 204, headers: corsHeaders() })

export const POST: RequestHandler = async ({ request }) => {
  const headers = corsHeaders()

  let body: SfuRequest
  try {
    body = (await request.json()) as SfuRequest
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400, headers })
  }

  if (!body.room || !body.openid_token?.access_token) {
    return json({ error: 'room and openid_token.access_token are required' }, { status: 400, headers })
  }

  try {
    const { jwt } = await handleSfuRequest(body)
    // MSC4195 response format: access_token + expires_in
    return json({ access_token: jwt, token_type: 'Bearer', expires_in: 3600 }, { headers })
  } catch (err) {
    // #257-1: a non-member request is an authorization failure (403), not a
    // gateway error (502).
    if (err instanceof RoomMembershipError) {
      return json({ error: err.message }, { status: 403, headers })
    }
    const message = err instanceof Error ? err.message : 'Token mint failed'
    return json({ error: message }, { status: 502, headers })
  }
}
