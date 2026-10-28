import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { readErasureReport } from '$lib/server/erasure/service'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// TRD-196: read ONE erasure report (IT-admin only). The service scopes the read
// to the current tenant, so another tenant's report id is a plain 404.
export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!UUID.test(params.id)) return json({ success: false, error: 'Not found' }, { status: 404 })
  const report = await readErasureReport(params.id)
  if (!report) return json({ success: false, error: 'Not found' }, { status: 404 })
  return json({ success: true, data: report })
}
