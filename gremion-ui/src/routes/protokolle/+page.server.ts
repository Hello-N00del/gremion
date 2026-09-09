import type { PageServerLoad } from './$types'
import { listProtocols } from '$lib/server/governance/protocols-db'

// Aggregates every committee's meeting minutes (see protocols-db.listProtocols).
// DB unavailability degrades to an empty list → first-class empty state.
export const load: PageServerLoad = async () => {
  const protocols = await listProtocols().catch(() => [])
  return { protocols }
}
