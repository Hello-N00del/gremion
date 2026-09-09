import { json } from '@sveltejs/kit'
import { readConfig, writeConfig } from '$lib/server/config'
import { generateLoeschkonzept } from '$lib/server/loeschkonzept'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { z } from 'zod'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const config = readConfig()
  const document = generateLoeschkonzept(config)
  return json({ success: true, data: { document } })
}

const compliancePatchSchema = z.object({
  dpo_name: z.string().max(200).optional(),
  dpo_email: z.string().email().max(200).optional(),
  controller_name: z.string().max(200).optional(),
  controller_address: z.string().max(500).optional(),
  purpose_description: z.string().max(2000).optional(),
})

export const PATCH: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const body = await request.json()
  const parsed = compliancePatchSchema.safeParse(body)
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  const updated = writeConfig({ compliance: parsed.data })
  const document = generateLoeschkonzept(updated)
  return json({ success: true, data: { document } })
}
