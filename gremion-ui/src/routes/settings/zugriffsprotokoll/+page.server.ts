import { redirect } from '@sveltejs/kit'
import { AccessLogNotConfigured, DEFAULT_LIMIT, listAccessRecords, NOT_CONFIGURED_DE, type AccessRecord } from '$lib/server/access-records'
import type { PageServerLoad } from './$types'

// TRD-092 / PRD-OPS-006: "Zugriffsprotokoll des Betreibers" -- who reached this
// council's data, when, what and why. Council administration only (the same
// gate as the settings layout's isAdmin); the rows are those of the request
// tenant. A read failure is shown as such, never as an empty list.
export const load: PageServerLoad = async ({ parent, locals }) => {
  const { isAdmin } = await parent()
  if (!isAdmin) redirect(302, '/settings')
  const slug = locals.tenant?.slug
  if (!slug) return { records: [] as AccessRecord[], problem: 'Kein Mandant aufgelöst.' }
  try {
    return { records: await listAccessRecords(slug, DEFAULT_LIMIT, null), problem: null as string | null }
  } catch (err) {
    if (err instanceof AccessLogNotConfigured) return { records: [] as AccessRecord[], problem: NOT_CONFIGURED_DE }
    console.error('[zugriffsprotokoll] read failed:', (err as Error).message)
    return { records: [] as AccessRecord[], problem: 'Das Zugriffsprotokoll konnte nicht gelesen werden.' }
  }
}
