// POST /api/content/lists/[id]/members — add a member to a content mailing list
// (manual email + optional name). UNIQUE(list,email) makes re-adds a no-op.
// Gated by `content.author`.
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'
import { requireContentId } from '$lib/server/content/ids'

export const POST: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)
  const listId = requireContentId(event.params.id) // F1-FIX-07 H08

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON')
  }
  const { email, name } = body as { email?: string; name?: string }
  if (typeof email !== 'string' || !email.includes('@')) throw error(400, 'a valid email is required')

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  await backend.addListMember(listId, {
    email: email.trim().toLowerCase(),
    name: name?.trim() || null,
    source: 'manual',
  })
  return json({ ok: true })
}
