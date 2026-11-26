import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { requireCommitteeId } from '$lib/server/governance/route-ids'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const user = locals.user
  if (!user) throw error(401, 'Unauthenticated')

  requireCommitteeId(params.id)

  const res = await fetch(`/api/protocols?committeeId=${params.id}`)
  if (!res.ok) throw error(res.status, 'Protokolle konnten nicht geladen werden')
  const { protocols } = await res.json()
  return { protocols, committeeId: params.id }
}
