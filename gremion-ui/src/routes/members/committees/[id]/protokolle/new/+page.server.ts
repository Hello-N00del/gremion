import { error, redirect } from '@sveltejs/kit'
import type { PageServerLoad, Actions } from './$types'
import { hasRole, Role } from '$lib/auth'

export const load: PageServerLoad = async ({ params, fetch, locals }) => {
  const user = locals.user
  if (!user) throw error(401, 'Unauthenticated')
  if (!hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Admins können Protokolle erstellen')

  const res = await fetch(`/api/governance/committees/${params.id}/members`)
  const members = res.ok ? (await res.json()).members : []
  return { committeeId: params.id, members }
}

export const actions: Actions = {
  default: async ({ request, params, fetch }) => {
    const data = await request.formData()
    const title = data.get('title') as string
    const meetingDate = data.get('meetingDate') as string
    const location = data.get('location') as string | null

    if (!title || !meetingDate) return { error: 'Titel und Datum sind erforderlich' }

    const res = await fetch('/api/protocols', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ committeeId: params.id, title, meetingDate, location }),
    })
    if (!res.ok) return { error: 'Protokoll konnte nicht erstellt werden' }
    const { protocol } = await res.json()
    redirect(303, `/members/committees/${params.id}/protokolle/${protocol.id}`)
  },
}
