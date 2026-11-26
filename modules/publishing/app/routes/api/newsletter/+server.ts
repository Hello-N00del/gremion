import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import { resolveNewsletterBackendOr503 } from '$lib/server/newsletter/backend/resolve'
import { createNextcloudClient } from '$lib/server/files/nextcloud-client'
import { createEmptyOdt } from '$lib/server/newsletter/collabora-convert'
import { serviceEnv } from '$lib/server/env/service-env'
import { mkcolIfMissing, newsletterDraftRoot, newsletterTenantFolder } from '$lib/server/newsletter/draft-path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const createSchema = z.object({
  title: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  recipients: z.array(
    z.union([
      z.object({ mailing_list_id: z.number().int().positive() }),
      z.object({ keycloak_group_id: z.string().uuid() }),
    ])
  ).optional(),
})

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user || !hasRole(locals.user.roles, Role.Finance)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const backend = resolveNewsletterBackendOr503()
  if (backend instanceof Response) return backend
  return json({ success: true, data: await backend.listNewsletters() })
}

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

  const { title, subject, recipients } = parsed.data
  const nc = createNextcloudClient()
  // #412: same sys-user resolution as the wopi-token route, so the write path
  // and the admin-side editor read path agree on the owning WebDAV space.
  const adminUser = serviceEnv('NEXTCLOUD_ADMIN_USER') ?? 'admin'

  // The shared admin space holds every customer's drafts, so the draft goes into
  // the customer's own folder under a random name (no title, no clock).
  let tenantFolder: string
  try {
    tenantFolder = newsletterTenantFolder(adminUser, locals.tenant.id)
  } catch (err) {
    console.error('[api/newsletter] refusing to create a draft:', err)
    return json({ success: false, error: 'Newsletter konnte nicht angelegt werden.' }, { status: 500 })
  }
  const odtPath = `${tenantFolder}/${randomUUID()}.odt`
  const odtBuffer = await createEmptyOdt()

  // #208: the ODT upload is a hard dependency on Nextcloud. If it is down the
  // raw throw surfaces as an opaque 500; wrap it so a Nextcloud outage yields a
  // structured 502 the client can show instead.
  try {
    // Both levels, shared folder first; "already exists" (405) is fine.
    await mkcolIfMissing(nc, newsletterDraftRoot(adminUser), adminUser)
    await mkcolIfMissing(nc, tenantFolder, adminUser)
    await nc.upload(odtPath, adminUser, odtBuffer, 'application/vnd.oasis.opendocument.text')
  } catch (uploadErr) {
    console.error('[api/newsletter] Nextcloud ODT upload failed:', uploadErr)
    return json(
      { success: false, error: 'Newsletter-Dokument konnte nicht in Nextcloud angelegt werden.' },
      { status: 502 }
    )
  }

  let newsletter
  try {
    newsletter = await backend.createNewsletter({
      title,
      odt_path: odtPath,
      subject,
      created_by: locals.user.id,
    })

    if (recipients?.length) {
      await backend.setNewsletterRecipients(newsletter.id, recipients.map((r) =>
        'mailing_list_id' in r
          ? { mailing_list_id: r.mailing_list_id, keycloak_group_id: undefined }
          : { mailing_list_id: undefined, keycloak_group_id: r.keycloak_group_id }
      ))
    }
  } catch (err) {
    // Compensating cleanup (#185): the ODT was uploaded to Nextcloud before this
    // DB write. A failed insert would orphan the file, so remove it before
    // returning. Best-effort — a failed delete is logged, not surfaced.
    console.error('[api/newsletter] create failed, removing orphaned ODT:', err)
    await nc.delete(odtPath, adminUser).catch((delErr) =>
      console.error('[api/newsletter] orphaned ODT cleanup failed:', delErr))
    return json({ success: false, error: 'Newsletter konnte nicht angelegt werden.' }, { status: 500 })
  }

  return json({ success: true, data: newsletter }, { status: 201 })
}
