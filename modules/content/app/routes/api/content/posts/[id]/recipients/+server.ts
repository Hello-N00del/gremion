// GET / PUT /api/content/posts/[id]/recipients — the email recipient set for a
// post. Recipients are a wholesale set; each entry targets EXACTLY one of a
// content mailing list OR a Keycloak group (the DB CHECK enforces the XOR).
//
//   - GET → { recipients, lists, groups }: the post's current recipient set
//           plus the pickable content mailing lists and KC groups for the UI.
//   - PUT → replace the recipient set ({ recipients: [{mailing_list_id} | {keycloak_group_id}] }).
//
// Gated by `content.author` (same capability as authoring/recipient curation;
// the heavier `content.publish` gates the actual send). The KC group list is a
// best-effort convenience for the picker — if the admin lookup fails we still
// return lists + recipients so the operator can manage mailing lists.
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'

export const GET: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const post = await backend.getPost(event.params.id)
  if (!post) throw error(404, 'Not found')

  const [recipients, lists] = await Promise.all([
    backend.getPostRecipients(post.id),
    backend.listMailingLists(),
  ])

  // Best-effort KC group list for the picker; degrade gracefully on failure so
  // mailing-list-only flows keep working when the admin lookup is unavailable.
  let groups: { id: string; name: string; path: string }[] = []
  try {
    const kc = getKeycloakAdminClientForCurrentTenant()
    const raw = await kc.listGroups()
    groups = raw.map((g) => ({ id: g.id, name: g.name, path: g.path }))
  } catch (err) {
    console.error('[content:recipients] KC group list failed', err)
  }

  return json({ recipients, lists, groups })
}

export const PUT: RequestHandler = async (event) => {
  requireContentAuthor(event.locals.user)

  const resolved = resolveContentBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved

  const post = await backend.getPost(event.params.id)
  if (!post) throw error(404, 'Not found')

  let body: unknown
  try {
    body = await event.request.json()
  } catch {
    throw error(400, 'Invalid JSON')
  }

  const { recipients } = body as {
    recipients?: { mailing_list_id?: string; keycloak_group_id?: string }[]
  }
  if (!Array.isArray(recipients)) throw error(400, 'recipients must be an array')

  // Validate each entry targets EXACTLY one of a list OR a group (mirror the DB
  // CHECK so we 400 early rather than surfacing a constraint violation).
  for (const r of recipients) {
    const hasList = typeof r?.mailing_list_id === 'string' && r.mailing_list_id.length > 0
    const hasGroup = typeof r?.keycloak_group_id === 'string' && r.keycloak_group_id.length > 0
    if (hasList === hasGroup)
      throw error(400, 'each recipient targets EXACTLY one of mailing_list_id OR keycloak_group_id')
  }

  await backend.setPostRecipients(
    post.id,
    recipients.map((r) =>
      r.mailing_list_id
        ? { mailing_list_id: r.mailing_list_id }
        : { keycloak_group_id: r.keycloak_group_id },
    ),
  )

  return json({ ok: true })
}
