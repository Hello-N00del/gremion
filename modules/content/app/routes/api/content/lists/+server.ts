// GET / POST /api/content/lists — the content engine's OWN mailing lists
// (content.mailing_lists, migration 045). Self-contained: NOT the newsletter
// leaf's lists. Gated by `content.author`.
//
//   - GET  → all mailing lists for the current tenant.
//   - POST → create a list ({ name }).
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'

export const GET: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)
  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  return json({ lists: await backend.listMailingLists() })
}

export const POST: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON')
  }
  const { name } = body as { name?: string }
  if (typeof name !== 'string' || !name.trim()) throw error(400, 'name is required')

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const list = await backend.createMailingList(name.trim())
  return json(list, { status: 201 })
}
