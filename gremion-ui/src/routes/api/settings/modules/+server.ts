import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import type { SessionUser } from '$lib/auth/types'
import { SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'
import { CouncilNotConfigured } from '$lib/server/module-switch/council-db'
import { previewSwitchOff } from '$lib/server/module-switch/preview'
import { loadModuleOverview, mayManageModules, submitModuleSwitch, type SwitchInput } from '$lib/server/module-switch/service'
import { MODULE_SWITCH_REQUIRED_LOA } from '$lib/server/module-switch/step-up'

// Karenz phase 1: council module self-service.
//   GET  /api/settings/modules                    -> the switchable modules and their state
//   GET  /api/settings/modules?preview=<id>       -> what a switch-off would delete (the warning's data)
//   POST /api/settings/modules {moduleId, action} -> queue a switch (201 { success, requestId })
// Council-admin only (it-admin through the role hierarchy). The POST needs a FRESH LoA 2 and the session's
// signed token pair: a 401 { error: 'STEP_UP_REQUIRED', requiredLoa } tells the client to run the
// /auth/step-up flow and retry, like the other step-up routes. Every refusal is { success:false, code,
// error } so the settings page can show the reason; nothing is queued on any of them.

const NOT_CONFIGURED = { success: false, code: 'NOT_CONFIGURED', error: 'Modulschalter nicht konfiguriert.' }
const stepUp = () => json({ error: 'STEP_UP_REQUIRED', requiredLoa: MODULE_SWITCH_REQUIRED_LOA }, { status: 401 })
const forbidden = () => json({ success: false, error: 'Forbidden' }, { status: 403 })

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!mayManageModules(user)) return forbidden()
  const tokens = session as unknown as { idToken?: string; accessToken?: string }
  // The executor re-verifies the signed pair; a session that lost it (a refresh without an id token) signs in again.
  if (!tokens.idToken || !tokens.accessToken) return stepUp()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    return json({ success: false, code: 'BAD_INPUT', error: 'Der Anfragetext ist kein gültiges JSON.' }, { status: 400 })
  }

  try {
    const result = await submitModuleSwitch(
      { tenant: locals.tenant, user, idToken: tokens.idToken, accessToken: tokens.accessToken },
      body as SwitchInput,
    )
    if (result.ok) return json({ success: true, requestId: result.requestId }, { status: 201 })
    if (result.code === 'STEP_UP_REQUIRED') return stepUp()
    return json({ success: false, code: result.code, error: result.message }, { status: result.status })
  } catch (err) {
    console.error('[settings/modules] switch failed:', err instanceof Error ? err.message : err)
    return json({ success: false, code: 'INTERNAL', error: 'Die Anfrage konnte nicht verarbeitet werden.' }, { status: 500 })
  }
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!mayManageModules(user)) return forbidden()

  try {
    const preview = url.searchParams.get('preview')
    if (preview !== null) {
      if (!SWITCHABLE_CATALOGUE_IDS.has(preview)) {
        return json({ success: false, code: 'MODULE_NOT_SWITCHABLE', error: 'Dieses Modul kann nicht von der Gremiumsverwaltung geschaltet werden.' }, { status: 422 })
      }
      return json({ success: true, data: await previewSwitchOff(locals.tenant, preview) })
    }
    return json({ success: true, data: await loadModuleOverview(locals.tenant) })
  } catch (err) {
    if (err instanceof CouncilNotConfigured) return json(NOT_CONFIGURED, { status: 503 })
    console.error('[settings/modules] read failed:', err instanceof Error ? err.message : err)
    return json({ success: false, code: 'INTERNAL', error: 'Die Module konnten nicht geladen werden.' }, { status: 500 })
  }
}
