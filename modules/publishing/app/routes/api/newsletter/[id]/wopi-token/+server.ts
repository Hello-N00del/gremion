import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { serviceEnv } from '$lib/server/env/service-env'

// #412: the draft ODT lives in the ADMIN Nextcloud space (uploaded by the
// api/newsletter POST as the sys user), so the generic per-user /files/edit
// editor PROPFINDs it under the logged-in user's UUID → 404 → 500. Mint the
// Collabora token admin-side instead — same pattern as the protocols WOPI path
// (protocol-documents.ts getDraftWopiToken).
function sysUser(): string {
  return serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'
}

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const id = parseInt(params.id, 10)
  if (isNaN(id)) return json({ success: false, error: 'Invalid id' }, { status: 400 })
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  const newsletter = await backend.getNewsletter(id)
  if (!newsletter || !newsletter.odt_path) {
    return json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // Same editable set as the schedule route: a sent/sending newsletter's ODT
  // is an archive — minting an edit token for it would let the archived
  // content be rewritten via Collabora.
  if (!['draft', 'failed'].includes(newsletter.status)) {
    return json({ success: false, error: 'Not editable' }, { status: 403 })
  }

  // Admin Basic auth — deliberately NO webdavBearer: the file is not in the
  // requesting user's WebDAV space.
  const nc = createNextcloudClient()
  const adminUser = sysUser()
  // odt_path is already the full dav path (see api/newsletter POST).
  try {
    const fileId = await nc.getFileId(newsletter.odt_path, adminUser)
    return json(await nc.getCollaboraEditorUrl(fileId, adminUser))
  } catch (err) {
    // A Nextcloud/Collabora outage (or the ODT having vanished admin-side) must
    // not bubble up as an unhandled 500. Return a structured 502 so the detail
    // page's `if (tokenRes.ok)` gate simply omits the inline editor.
    console.error(`[newsletter/${id}/wopi-token] Nextcloud editor token failed:`, err)
    return json(
      { success: false, error: 'Editor-Dienst nicht verfügbar' },
      { status: 502 },
    )
  }
}
