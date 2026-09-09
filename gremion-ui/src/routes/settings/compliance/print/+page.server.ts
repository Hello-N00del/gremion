import { redirect } from '@sveltejs/kit'
import { generateLoeschkonzept } from '$lib/server/loeschkonzept'
import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ parent }) => {
  const { isITAdmin, config } = await parent()
  if (!isITAdmin || !config) redirect(302, '/settings')
  return { document: generateLoeschkonzept(config) }
}
