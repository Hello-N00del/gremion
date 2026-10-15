import { redirect, error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendForPage } from '$lib/server/newsletter/backend/resolve'

export const load: PageServerLoad = async ({ locals, params, fetch }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    redirect(302, '/auth/login?error=forbidden')
  }
  const id = parseInt(params.id, 10)
  if (isNaN(id)) error(400, 'Invalid id')
  const backend = resolveNewsletterBackendForPage()
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter) error(404, 'Newsletter not found')

  // #412: admin-resolved Collabora token for the inline editor (mirrors the
  // protocols draft embed) — the ODT lives in the admin space, not the user's.
  let wopiToken: { editorUrl: string; tokenTtl: number } | null = null
  // Match the wopi-token API's editable gate (dc1718f5): a failed send is still
  // editable so the user can fix and retry it, so mint the editor token for
  // 'failed' as well as 'draft'.
  if (['draft', 'failed'].includes(newsletter.status)) {
    const tokenRes = await fetch(`/api/newsletter/${id}/wopi-token`)
    if (tokenRes.ok) wopiToken = await tokenRes.json()
  }

  return {
    newsletter,
    wopiToken,
    recipients: await backend.getNewsletterRecipients(id),
    lists: await backend.listMailingLists(),
  }
}
