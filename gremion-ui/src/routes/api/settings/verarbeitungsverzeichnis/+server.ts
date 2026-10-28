import { json } from '@sveltejs/kit'
import { readConfig, writeConfig, processingOverrideSchema } from '$lib/server/config'
import { buildProcessingActivities, generateVerarbeitungsverzeichnis } from '$lib/server/verarbeitungsverzeichnis'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { z } from 'zod'
import type { RequestHandler } from './$types'

// TRD-162: same authz as /api/settings/loeschkonzept (it-admin only); the
// config is the request tenant's own (readConfig/writeConfig default to
// requireTenant()), so there is no cross-tenant path.
async function isAdmin(locals: App.Locals): Promise<boolean> {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  return !!user && hasRole(user.roles, Role.ITAdmin)
}

function view(config: ReturnType<typeof readConfig>) {
  return {
    document: generateVerarbeitungsverzeichnis(config),
    activities: buildProcessingActivities(config),
    // Kept for disabled modules too, so re-enabling regenerates the same text.
    overrides: config.compliance.processing_overrides ?? {},
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!(await isAdmin(locals))) return json({ success: false, error: 'Forbidden' }, { status: 403 })
  return json({ success: true, data: view(readConfig()) })
}

const knownIds = new Set(MODULE_MANIFESTS.map((m) => m.id))
const patchSchema = z.object({
  // Whole-map replace (like terms/roles): omit a module to drop its override.
  overrides: z
    .record(z.string(), processingOverrideSchema.strict())
    .refine((o) => Object.keys(o).every((id) => knownIds.has(id)), { message: 'Unknown module id' }),
})

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!(await isAdmin(locals))) return json({ success: false, error: 'Forbidden' }, { status: 403 })
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  const updated = writeConfig({ compliance: { processing_overrides: parsed.data.overrides } })
  return json({ success: true, data: view(updated) })
}
