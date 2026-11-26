import { redirect, error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendForPage } from '$lib/server/newsletter/backend/resolve'
import { parseRouteId } from '$lib/server/newsletter/route-ids'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { convertOdtToHtml } from '$lib/server/newsletter/collabora-convert'
import { sanitizeRichHtml } from '$lib/server/security/html-sanitize'
import { serviceEnv } from '$lib/server/env/service-env'

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    redirect(302, '/auth/login?error=forbidden')
  }
  const id = parseRouteId(params.id)
  if (id === null) error(404, 'Newsletter not found')
  const backend = resolveNewsletterBackendForPage()
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) error(404, 'Not found')

  const nc = createNextcloudClient()
  // Same sys-user resolution as the write path and the preview API route.
  const res = await nc.download(newsletter.odt_path, serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin')
  const odtBuffer = await res.arrayBuffer()
  // #232 — Collabora/LibreOffice HTML is untrusted (G-011 class); sanitize
  // before it reaches the {@html} sink in +page.svelte, matching the
  // protocol-publish and news-edit flows.
  const html = sanitizeRichHtml(await convertOdtToHtml(odtBuffer))

  return { html }
}
