// GET /api/content/posts — list posts (any Mitglied may view the authoring
// surface). POST /api/content/posts — create a post (content.author capability).
//
// The `content` module-disable gate is enforced upstream in hooks.server.ts
// (moduleGateResponse over the /api/content prefix); these handlers add the
// per-request role/capability gate. Mirrors the news API shape (auth → parse →
// db call → json).
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentRead, requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'

export const GET: RequestHandler = async (event) => {
  requireContentRead(event.locals.user)
  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const posts = await backend.listPosts()
  return json(posts)
}

export const POST: RequestHandler = async (event) => {
  const user = requireContentAuthor(event.locals.user)

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON')
  }

  const { title } = body as { title?: string }
  if (!title?.trim()) throw error(400, 'title is required')

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const post = await backend.createPost({ title: title.trim(), created_by: user.id })
  return json(post, { status: 201 })
}
