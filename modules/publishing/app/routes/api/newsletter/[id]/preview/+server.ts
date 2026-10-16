import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { convertOdtToHtml } from '$lib/server/newsletter/collabora-convert'
import { sanitizeRichHtml } from '$lib/server/security/html-sanitize'
import { serviceEnv } from '$lib/server/env/service-env'

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const id = parseInt(params.id, 10)
  if (isNaN(id)) return json({ success: false, error: 'Invalid id' }, { status: 400 })
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) return json({ success: false, error: 'Not found' }, { status: 404 })

  const nc = createNextcloudClient()
  // Same sys-user resolution as the write path (api/newsletter POST) and the
  // wopi-token route — the ODT lives in the admin space, not the requester's.
  const res = await nc.download(newsletter.odt_path, serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin')
  const odtBuffer = await res.arrayBuffer()
  // #232 — this endpoint serves Collabora/LibreOffice HTML as text/html at the
  // app origin (directly navigable); sanitize the untrusted conversion output
  // (G-011 class) before returning it, matching the page-loader preview.
  const html = sanitizeRichHtml(await convertOdtToHtml(odtBuffer))

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
