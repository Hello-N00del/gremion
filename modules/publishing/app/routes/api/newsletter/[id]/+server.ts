import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { parseJsonBody } from '$lib/server/parse-json-body'
import { z } from 'zod'

function requireFinance(locals: App.Locals): Response | null {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  return null
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const forbidden = requireFinance(locals)
  if (forbidden) return forbidden
  const id = parseInt(params.id, 10)
  if (isNaN(id)) return json({ success: false, error: 'Invalid id' }, { status: 400 })
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) return json({ success: false, error: 'Not found' }, { status: 404 })
  const recipients = await backend.getNewsletterRecipients(id)
  return json({ success: true, data: { ...newsletter, recipients } })
}

const patchSchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  recipients: z.array(
    z.union([
      z.object({ mailing_list_id: z.number().int().positive() }),
      z.object({ keycloak_group_id: z.string().uuid() }),
    ])
  ).optional(),
})

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const forbidden = requireFinance(locals)
  if (forbidden) return forbidden
  const id = parseInt(params.id, 10)
  if (isNaN(id)) return json({ success: false, error: 'Invalid id' }, { status: 400 })
  const body = await parseJsonBody(request)
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) return json({ success: false, error: 'Not found' }, { status: 404 })
  if (newsletter.status !== 'draft') {
    return json({ success: false, error: 'Only draft newsletters can be edited' }, { status: 409 })
  }
  if (parsed.data.subject) await backend.updateNewsletter(id, { subject: parsed.data.subject })
  if (parsed.data.recipients) {
    await backend.setNewsletterRecipients(id, parsed.data.recipients.map((r) =>
      'mailing_list_id' in r
        ? { mailing_list_id: r.mailing_list_id, keycloak_group_id: undefined }
        : { mailing_list_id: undefined, keycloak_group_id: r.keycloak_group_id }
    ))
  }
  return json({ success: true, data: await backend.getNewsletter(id) })
}
