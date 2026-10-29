import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { readErasureReports } from '$lib/server/erasure/service'
import { adminOrNull, forbidden, isKeycloakId } from '$lib/server/erasure/route-guards'

// R33f LOW: look the reports of ONE person up by a POST body. The subject id of a person
// being erased must not sit in a URL (proxy and access logs keep query strings). IT-admin
// only; reading needs no step-up, like the list.
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!(await adminOrNull(locals))) return forbidden()
  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    /* handled below as an invalid id */
  }
  const raw = typeof body === 'object' && body !== null ? (body as { subjectId?: unknown }).subjectId : undefined
  const subjectId = typeof raw === 'string' ? raw.trim() : ''
  if (!isKeycloakId(subjectId)) return json({ success: false, error: 'subjectId fehlt oder ist ungültig.' }, { status: 422 })
  return json({ success: true, data: await readErasureReports({ subjectId }) })
}
