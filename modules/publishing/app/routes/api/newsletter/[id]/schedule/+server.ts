import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { z } from 'zod'

const scheduleSchema = z.object({
  scheduled_at: z.string().datetime({ offset: true }),
})

export const POST: RequestHandler = async ({ request, params, locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const id = parseInt(params.id, 10)
  if (isNaN(id)) return json({ success: false, error: 'Invalid id' }, { status: 400 })
  const body = await request.json()
  const parsed = scheduleSchema.safeParse(body)
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) return json({ success: false, error: 'Not found' }, { status: 404 })
  if (!['draft', 'failed'].includes(newsletter.status)) {
    return json({ success: false, error: `Cannot schedule newsletter with status '${newsletter.status}'` }, { status: 409 })
  }
  const utc = new Date(parsed.data.scheduled_at).toISOString().replace('T', ' ').replace('Z', '')
  await backend.updateNewsletter(id, { status: 'scheduled', scheduled_at: utc })
  return json({ success: true, data: await backend.getNewsletter(id) })
}
