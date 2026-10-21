import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { parseCsvMembers } from '$lib/server/newsletter/csv-import'
import { z } from 'zod'

const manualSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
})

export const POST: RequestHandler = async ({ request, params, locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const listId = parseInt(params.id, 10)
  if (isNaN(listId)) return json({ success: false, error: 'Invalid id' }, { status: 400 })

  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('text/csv')) {
    const csv = await request.text()
    const { valid, skipped } = parseCsvMembers(csv)
    const backend = resolveNewsletterBackendOr503()
    if (backend instanceof Response) return backend
    for (const { email, name } of valid) {
      await backend.addMember(listId, email, name, 'csv')
    }
    return json({ success: true, data: { imported: valid.length, skipped } })
  }

  const body = await request.json()
  const parsed = manualSchema.safeParse(body)
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  await backend.addMember(listId, parsed.data.email, parsed.data.name ?? null, 'manual')
  return json({ success: true, data: { imported: 1, skipped: 0 } }, { status: 201 })
}

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const listId = parseInt(params.id, 10)
  if (isNaN(listId)) return json({ success: false, error: 'Invalid id' }, { status: 400 })
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const members = await backend.listMembers(listId)
  return json({ success: true, data: members })
}
