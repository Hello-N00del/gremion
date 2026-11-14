// GET / PUT /api/content/posts/[id]/recipients — the email recipient set for a
// post. Recipients are a wholesale set; each entry targets EXACTLY one of a
// content mailing list OR a Keycloak group (the DB CHECK enforces the XOR).
//
//   - GET → { recipients, lists, groups }: the post's current recipient set
//           plus the pickable content mailing lists and KC groups for the UI.
//   - PUT → replace the recipient set ({ recipients: [{mailing_list_id} | {keycloak_group_id}] }).
//           A group must be the group of an org unit, as in the picker. Answers
//           { ok, removed }: `removed` names stored groups that are no org-unit
//           group any more and were left out of the new set.
//
// Gated by `content.author` (same capability as authoring/recipient curation;
// the heavier `content.publish` gates the actual send). The KC group list is a
// best-effort convenience for the picker, limited to the groups of the customer's
// org units — if the admin lookup fails we still
// return lists + recipients so the operator can manage mailing lists.
import { json, error } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { requireContentAuthor } from '$lib/server/content/route-auth'
import { resolveContentBackendOr503 } from '$lib/server/content/backend/resolve'
import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'
import { listOrgUnitGroupIds, onlyOrgUnitGroups } from '$lib/server/content/recipient-groups'

const MAX_RECIPIENT_ENTRIES = 200

// Log the error class only: a Keycloak error body can echo what was asked for.
const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err)

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
    // The whole tree: bodies (Vorstand, Referate) are subgroups. Only the groups
    // of the customer's org units are offered, not the technical Keycloak groups;
    // if the org units cannot be read, no group is offered (never all of them).
    const [raw, orgUnitGroupIds] = await Promise.all([kc.listGroupTree(), listOrgUnitGroupIds()])
    groups = onlyOrgUnitGroups(
      raw.map((g) => ({ id: g.id, name: g.name, path: g.path })),
      orgUnitGroupIds,
    )
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
  if (recipients.length > MAX_RECIPIENT_ENTRIES) {
    // The editor shows this text to the author.
    throw error(400, `Empfänger: höchstens ${MAX_RECIPIENT_ENTRIES} Einträge`)
  }

  // Validate each entry targets EXACTLY one of a list OR a group (mirror the DB
  // CHECK so we 400 early rather than surfacing a constraint violation).
  for (const r of recipients) {
    const hasList = typeof r?.mailing_list_id === 'string' && r.mailing_list_id.length > 0
    const hasGroup = typeof r?.keycloak_group_id === 'string' && r.keycloak_group_id.length > 0
    if (hasList === hasGroup)
      throw error(400, 'each recipient targets EXACTLY one of mailing_list_id OR keycloak_group_id')
  }

  const requestedGroupIds = [
    ...new Set(recipients.map((r) => r.keycloak_group_id).filter((id): id is string => !!id)),
  ]

  // The same rule as the picker: only the group of an org unit is a recipient.
  // The org units are read only when a group is in the set, so a save of
  // mailing lists alone does not depend on them. If they cannot be read, no
  // group is accepted (never all of them).
  let orgUnitGroupIds: ReadonlySet<string> = new Set()
  if (requestedGroupIds.length > 0) {
    let unreadable = false
    try {
      orgUnitGroupIds = await listOrgUnitGroupIds()
    } catch (err) {
      console.error('[content:recipients] org units unreadable, group recipients refused', errName(err))
      unreadable = true
    }
    if (unreadable) {
      // The editor shows this text to the author.
      throw error(503, 'Die Gruppen der Gremien können gerade nicht geprüft werden. Bitte später erneut versuchen.')
    }
  }

  // A group that is no org-unit group is refused, naming the id as it was sent;
  // the answer does not depend on whether Keycloak knows the group. One case is
  // not a refusal: a group that is already stored for this post and stopped
  // being an org-unit group since. It is left out of the new set and reported
  // as `removed`, so the author can still save the other changes.
  const foreign = requestedGroupIds.filter((id) => !orgUnitGroupIds.has(id))
  if (foreign.length > 0) {
    const stored = new Set((await backend.getPostRecipients(post.id)).map((r) => r.keycloak_group_id))
    const refused = foreign.find((id) => !stored.has(id))
    if (refused !== undefined) {
      // The editor shows this text to the author.
      throw error(400, `Diese Gruppe gehört zu keinem Gremium und kann nicht angeschrieben werden: ${refused}`)
    }
  }
  const removed = new Set(foreign)

  // A group id that Keycloak does not know would later make the whole send
  // fail, mailing lists included. Refuse it now, naming the id. Only a definite
  // miss refuses: a Keycloak outage must not block saving mailing lists.
  // Status/name checks, not instanceof: the admin module is mocked in tests.
  // Each distinct id is checked once, and the checks stop at the first failure
  // that is not a definite miss (an outage would otherwise cost one full
  // timeout per id).
  const groupIds = requestedGroupIds.filter((id) => !removed.has(id))
  if (groupIds.length > 0) {
    let kc: { getGroup(id: string): Promise<unknown> } | null = null
    try {
      kc = getKeycloakAdminClientForCurrentTenant()
    } catch (err) {
      console.error('[content:recipients] KC client unavailable, group ids not checked', errName(err))
    }
    for (const id of groupIds) {
      if (!kc) break
      try {
        await kc.getGroup(id)
      } catch (err) {
        const e = err as { status?: unknown; name?: unknown }
        if (e?.status === 404 || e?.name === 'KcInvalidIdError') {
          throw error(400, `Gruppe nicht gefunden: ${id}`)
        }
        console.error('[content:recipients] KC group check failed, remaining ids accepted unchecked', errName(err))
        break
      }
    }
  }

  await backend.setPostRecipients(
    post.id,
    recipients
      .filter((r) => !r.keycloak_group_id || !removed.has(r.keycloak_group_id))
      .map((r) =>
        r.mailing_list_id
          ? { mailing_list_id: r.mailing_list_id }
          : { keycloak_group_id: r.keycloak_group_id },
      ),
  )

  return json({ ok: true, removed: [...removed] })
}
