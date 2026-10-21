import { redirect, error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendForPage } from '$lib/server/newsletter/backend/resolve'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { convertOdtToHtml } from '$lib/server/newsletter/collabora-convert'
import { sanitizeRichHtml } from '$lib/server/security/html-sanitize'

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    redirect(302, '/auth/login?error=forbidden')
  }
  const id = parseInt(params.id, 10)
  if (isNaN(id)) error(400, 'Invalid id')
  const backend = resolveNewsletterBackendForPage()
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) error(404, 'Not found')

  const nc = createNextcloudClient()
  const res = await nc.download(newsletter.odt_path, 'admin')
  const odtBuffer = await res.arrayBuffer()
  // #232 — Collabora/LibreOffice HTML is untrusted (G-011 class); sanitize
  // before it reaches the {@html} sink in +page.svelte, matching the
  // protocol-publish and news-edit flows.
  const html = sanitizeRichHtml(await convertOdtToHtml(odtBuffer))

  return { html }
}
