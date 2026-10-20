import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { z } from 'zod'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const lists = await backend.listMailingLists()
  return json({ success: true, data: lists })
}

const createSchema = z.object({ name: z.string().min(1).max(100) })

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const list = await backend.createMailingList(parsed.data.name)
  return json({ success: true, data: list }, { status: 201 })
}
