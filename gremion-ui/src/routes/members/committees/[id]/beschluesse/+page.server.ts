import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ params, fetch, locals, url }) => {
  const user = locals.user
  if (!user) throw error(401, 'Unauthenticated')

  const year = url.searchParams.get('year') ?? ''
  const query = year ? `?year=${year}` : ''
  const res = await fetch(`/api/committees/${params.id}/beschluesse${query}`)
  if (!res.ok) throw error(res.status, 'Register konnte nicht geladen werden')
  const { entries, settings } = await res.json()
  return { entries, settings, committeeId: params.id, year }
}
