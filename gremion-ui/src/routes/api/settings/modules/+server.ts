import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import type { SessionUser } from '$lib/auth/types'
import { SWITCHABLE_CATALOGUE_IDS } from '$lib/modules/catalogue-map'
import { CouncilNotConfigured } from '$lib/server/module-switch/council-db'
import {
  armPendingSwitch,
  checkPendingSwitch,
  claimPendingSwitch,
  normalizePendingInput,
  PENDING_COOKIE,
  PENDING_COOKIE_PATH,
  PENDING_TTL_SECONDS,
  type PendingRefusal,
  type PendingSwitch,
} from '$lib/server/module-switch/pending'
import { loadOperatorModules } from '$lib/server/module-switch/operator-modules'
import { previewSwitchOff } from '$lib/server/module-switch/preview'
import { loadModuleOverview, mayManageModules, submitModuleSwitch, type SwitchContext, type SwitchInput } from '$lib/server/module-switch/service'
import { MODULE_SWITCH_REQUIRED_LOA } from '$lib/server/module-switch/step-up'

// Karenz phase 1: council module self-service.
//   GET  /api/settings/modules                    -> the switchable modules and their state, plus operatorModules (the others the customer has)
//   GET  /api/settings/modules?preview=<id>       -> what a switch-off would delete (the warning's data)
//   POST /api/settings/modules {moduleId, action} -> queue a switch (201 { success, requestId })
//   POST /api/settings/modules {resume: true}     -> carry out the switch confirmed before the second factor
// Council-admin only (it-admin through the role hierarchy). The POST needs a FRESH LoA 2 and the session's
// signed token pair: a 401 { error: 'STEP_UP_REQUIRED', requiredLoa } tells the client to run the
// /auth/step-up flow, like the other step-up routes. Every refusal is { success:false, code,
// error } so the settings page can show the reason; nothing is queued on any of them.
//
// The second factor is a round trip to the sign-in service, and the page loses what it held on the way.
// So the 401 also KEEPS the confirmed input (module-switch/pending.ts: one short-lived, single-use row per
// person, its handle in an HttpOnly cookie scoped to this path), and the page sends { resume: true } when
// it is back. The resume carries out that one confirmed switch through the unchanged switch service (the
// whole guard chain runs again, the fresh second factor included) and never asks for the second factor
// again: a resume that cannot be carried out is a 409 the page shows, and the admin starts over.

const NOT_CONFIGURED = { success: false, code: 'NOT_CONFIGURED', error: 'Modulschalter nicht konfiguriert.' }
const stepUp = () => json({ error: 'STEP_UP_REQUIRED', requiredLoa: MODULE_SWITCH_REQUIRED_LOA }, { status: 401 })
const forbidden = () => json({ success: false, error: 'Forbidden' }, { status: 403 })
const internal = () => json({ success: false, code: 'INTERNAL', error: 'Die Anfrage konnte nicht verarbeitet werden.' }, { status: 500 })

const RESUME_REFUSAL: Readonly<Record<PendingRefusal, { code: string; error: string }>> = {
  gone: { code: 'RESUME_GONE', error: 'Die bestätigte Aktion liegt nicht mehr vor. Bitte die Aktion erneut auslösen.' },
  expired: { code: 'RESUME_EXPIRED', error: 'Die Bestätigung hat zu lange gedauert. Bitte die Aktion erneut auslösen.' },
  unconfirmed: { code: 'RESUME_UNCONFIRMED', error: 'Die Zwei-Faktor-Prüfung wurde nicht abgeschlossen. Bitte die Aktion erneut auslösen.' },
}

/** A resume that is not carried out. `pending` (the caller's own claimed switch) names the module the page shows the reason on. */
function resumeRefused(reason: PendingRefusal, pending?: PendingSwitch | null): Response {
  const target = pending ? { moduleId: pending.input.moduleId, action: pending.input.action } : {}
  return json({ success: false, ...RESUME_REFUSAL[reason], ...target }, { status: 409 })
}

type Event = Parameters<RequestHandler>[0]
type Tokens = { idToken?: string; accessToken?: string }

const isResume = (body: unknown): boolean => typeof body === 'object' && body !== null && (body as { resume?: unknown }).resume === true

/**
 * The 401 is about to send the admin to the second factor: keep the confirmed input for the way back. Only a
 * shape-valid input is kept; anything else (and a failed write) leaves nothing behind, and the admin repeats
 * the action after the second factor.
 */
async function keepForSecondFactor({ locals, cookies }: Event, user: SessionUser, body: unknown): Promise<void> {
  const input = normalizePendingInput(body)
  if (input !== null) {
    try {
      const handle = await armPendingSwitch(locals.tenant.db, { userId: user.id, authTime: user.authTime, input })
      cookies.set(PENDING_COOKIE, handle, { path: PENDING_COOKIE_PATH, httpOnly: true, sameSite: 'strict', maxAge: PENDING_TTL_SECONDS })
      return
    } catch (err) {
      console.error('[settings/modules] the confirmed switch could not be kept for the second factor:', err instanceof Error ? err.message : err)
    }
  }
  cookies.delete(PENDING_COOKIE, { path: PENDING_COOKIE_PATH })
}

/** Carry out the switch that was confirmed before the second factor: at most once, by the person who confirmed it. */
async function resume({ locals, cookies }: Event, user: SessionUser, tokens: Tokens): Promise<Response> {
  const handle = cookies.get(PENDING_COOKIE)
  // The handle is spent whatever happens next (the row goes with the claim below).
  cookies.delete(PENDING_COOKIE, { path: PENDING_COOKIE_PATH })
  if (!handle) return resumeRefused('gone')

  let claimed: PendingSwitch | null
  try {
    claimed = await claimPendingSwitch(locals.tenant.db, handle)
  } catch (err) {
    console.error('[settings/modules] resume failed:', err instanceof Error ? err.message : err)
    return internal()
  }
  const check = checkPendingSwitch(claimed, user, MODULE_SWITCH_REQUIRED_LOA)
  // Another person's switch is answered like an unknown one, and names nothing.
  if (!check.ok) return resumeRefused(check.reason, check.reason === 'gone' ? null : claimed)
  const { pending } = check
  if (!tokens.idToken || !tokens.accessToken) return resumeRefused('unconfirmed', pending)

  const target = { moduleId: pending.input.moduleId, action: pending.input.action }
  try {
    const ctx: SwitchContext = { tenant: locals.tenant, user, idToken: tokens.idToken, accessToken: tokens.accessToken }
    // The key fixed at confirmation: the platform answers a second submit of it with the first request.
    const result = await submitModuleSwitch(ctx, pending.input, { newKey: () => pending.idempotencyKey })
    if (result.ok) return json({ success: true, resumed: true, requestId: result.requestId, ...target }, { status: 201 })
    // Never a second round trip from here: the confirmed switch is spent, the admin starts over.
    if (result.code === 'STEP_UP_REQUIRED') return resumeRefused('unconfirmed', pending)
    return json({ success: false, code: result.code, error: result.message, ...target }, { status: result.status })
  } catch (err) {
    console.error('[settings/modules] resumed switch failed:', err instanceof Error ? err.message : err)
    return internal()
  }
}

export const POST: RequestHandler = async (event) => {
  const { request, locals } = event
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!mayManageModules(user)) return forbidden()
  const tokens = session as unknown as Tokens

  let body: unknown = null
  let parsed = true
  try {
    body = await request.json()
  } catch {
    parsed = false
  }
  if (parsed && isResume(body)) return resume(event, user, tokens)

  // The executor re-verifies the signed pair; a session that lost it (a refresh without an id token) signs in again.
  if (!tokens.idToken || !tokens.accessToken) {
    await keepForSecondFactor(event, user, parsed ? body : null)
    return stepUp()
  }
  if (!parsed) return json({ success: false, code: 'BAD_INPUT', error: 'Der Anfragetext ist kein gültiges JSON.' }, { status: 400 })

  try {
    const result = await submitModuleSwitch(
      { tenant: locals.tenant, user, idToken: tokens.idToken, accessToken: tokens.accessToken },
      body as SwitchInput,
    )
    if (result.ok) return json({ success: true, requestId: result.requestId }, { status: 201 })
    if (result.code === 'STEP_UP_REQUIRED') {
      await keepForSecondFactor(event, user, body)
      return stepUp()
    }
    return json({ success: false, code: result.code, error: result.message }, { status: result.status })
  } catch (err) {
    console.error('[settings/modules] switch failed:', err instanceof Error ? err.message : err)
    return internal()
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
    // The switchable modules (with their switches) and, next to them, the ones the customer has that the council cannot switch.
    const overview = await loadModuleOverview(locals.tenant)
    return json({ success: true, data: { ...overview, operatorModules: await loadOperatorModules(locals.tenant) } })
  } catch (err) {
    if (err instanceof CouncilNotConfigured) return json(NOT_CONFIGURED, { status: 503 })
    console.error('[settings/modules] read failed:', err instanceof Error ? err.message : err)
    return json({ success: false, code: 'INTERNAL', error: 'Die Module konnten nicht geladen werden.' }, { status: 500 })
  }
}
