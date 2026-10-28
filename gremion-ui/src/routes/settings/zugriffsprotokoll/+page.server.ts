import { redirect } from '@sveltejs/kit'
import { AccessLogNotConfigured, DEFAULT_LIMIT, listAccessRecords, NOT_CONFIGURED_DE, type AccessRecord } from '$lib/server/access-records'
import type { PageServerLoad } from './$types'

// TRD-092 / PRD-OPS-006: "Zugriffsprotokoll des Betreibers" -- who reached this
// council's data, when, what and why. Council administration only (the same
// gate as the settings layout's isAdmin); the rows are those of the request
// tenant. A read failure is shown as such, never as an empty list. One page is
// the newest DEFAULT_LIMIT rows (?before=<time>: older than that); one row more
// is read to know whether older entries exist, and the page links to them.
export const load: PageServerLoad = async ({ parent, locals, url }) => {
  const { isAdmin } = await parent()
  if (!isAdmin) redirect(302, '/settings')
  const empty = { records: [] as AccessRecord[], older: null as string | null, limit: DEFAULT_LIMIT, paged: false }
  const slug = locals.tenant?.slug
  if (!slug) return { ...empty, problem: 'Kein Mandant aufgelöst.' }
  const raw = url.searchParams.get('before')
  const parsed = raw === null ? null : new Date(raw)
  const before = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
  try {
    const rows = await listAccessRecords(slug, DEFAULT_LIMIT + 1, before)
    const records = rows.slice(0, DEFAULT_LIMIT)
    const older = rows.length > DEFAULT_LIMIT ? records[records.length - 1]!.at : null
    return { records, older, limit: DEFAULT_LIMIT, paged: before !== null, problem: null as string | null }
  } catch (err) {
    if (err instanceof AccessLogNotConfigured) return { ...empty, problem: NOT_CONFIGURED_DE }
    console.error('[zugriffsprotokoll] read failed:', (err as Error).message)
    return { ...empty, problem: 'Das Zugriffsprotokoll konnte nicht gelesen werden.' }
  }
}
