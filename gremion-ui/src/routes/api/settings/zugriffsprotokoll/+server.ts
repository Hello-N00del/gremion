import { json } from '@sveltejs/kit'
import type { SessionUser } from '$lib/auth/types'
import { AccessLogNotConfigured, clampLimit, listAccessRecords, mayReadAccessRecords, NOT_CONFIGURED_DE } from '$lib/server/access-records'
import type { RequestHandler } from './$types'

// TRD-092 / PRD-OPS-006: GET the record of vendor and operator access to THIS
// council's data (who, when, what, why). Council administration only (403
// otherwise, before the database is asked); scoped to the request tenant -- no
// slug parameter exists, and a `slug` in the query string is ignored.
//   ?limit=1..200 (default 100)   ?before=<ISO time>  (older than: the next page)
export const GET: RequestHandler = async ({ locals, url }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!mayReadAccessRecords(user)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const slug = locals.tenant?.slug
  if (!slug) {
    return json({ success: false, error: 'Kein Mandant aufgelöst.' }, { status: 400 })
  }
  let before: Date | null = null
  const rawBefore = url.searchParams.get('before')
  if (rawBefore !== null) {
    before = new Date(rawBefore)
    if (Number.isNaN(before.getTime())) {
      return json({ success: false, error: 'Ungültiger Zeitpunkt (before).' }, { status: 400 })
    }
  }
  try {
    const records = await listAccessRecords(slug, clampLimit(url.searchParams.get('limit')), before)
    return json({ success: true, data: { records } })
  } catch (err) {
    if (err instanceof AccessLogNotConfigured) {
      return json({ success: false, error: NOT_CONFIGURED_DE }, { status: 503 })
    }
    console.error('[zugriffsprotokoll] read failed:', (err as Error).message)
    return json({ success: false, error: 'Das Zugriffsprotokoll konnte nicht gelesen werden.' }, { status: 503 })
  }
}
