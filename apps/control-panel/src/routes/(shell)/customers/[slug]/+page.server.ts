// One customer: its control row and, when configured, its provisioning ledger
// in EXECUTION_ORDER (the progress "Neuer Mandant" shows) -- and the state of
// its NEWEST request, which exists before the customer does (queued,
// verifying, running with its step, failed, refused). "Erneut versuchen" is a
// new request with a new idempotency key, only after failed/refused.
import { error, fail, redirect } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { lifecycleOffer, type LifecycleKind } from '$lib/lifecycle'
import { moduleActionsOffered, type ModuleKind } from '$lib/modules'
import { describeRequest } from '$lib/request-state'
import { evidenceFromRequest } from '$lib/server/auth'
import { loadConfig } from '$lib/server/config'
import { customerRequests, customerStatus, platformDb } from '$lib/server/customers'
import { submitLifecycle } from '$lib/server/lifecycle'
import { loadCustomerModules, moduleArgs, parseDpiaForm, requestEvents, submitModuleRequest, type CustomerModules, type EventLine } from '$lib/server/modules'
import { SubmitRefused } from '$lib/server/requests'
import { retryRequest } from '$lib/server/retry'
import type { Actions, PageServerLoad } from './$types'

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export const load: PageServerLoad = async ({ params }) => {
  if (!SLUG.test(params.slug) || params.slug.length > 30) error(404, 'no such customer')
  const r = loadConfig(env)
  if (!r.ok) error(503, 'the control panel is not configured')
  const status = await customerStatus(r.config, params.slug).catch((err: unknown) => {
    const e = err as { code?: string; message?: string }
    console.error(`[control-panel] customer status ${params.slug} failed: ${e?.code ?? 'no-sqlstate'}: ${e?.message ?? String(err)}`)
    error(503, 'the control registry or the platform ledger is not reachable (see the panel log)')
  })
  const requests = await customerRequests(r.config, params.slug).catch(() => [])
  const newest = requests[0]
  const latest = newest ? describeRequest(newest) : null
  // reload while the newest request is active; with no request, while the setup is
  // (a terminal newest request ends the refresh even if the customer row still says provisioning)
  const refresh = latest ? latest.active : status?.status === 'provisioning'
  const offer = lifecycleOffer(status?.status ?? null, newest ? { kind: newest.kind, state: newest.state, outcome: newest.outcome, evidenceVerifiedAt: newest.evidenceVerifiedAt } : null)
  const newestLite = newest ? { kind: newest.kind, state: newest.state, outcome: newest.outcome, evidenceVerifiedAt: newest.evidenceVerifiedAt } : null
  const p = platformDb(r.config)
  // the "Module" section: what is enabled and what could be, and whether an action can be queued now
  let moduleSection: { canAct: boolean; enabled: CustomerModules['enabled']; available: CustomerModules['available'] } | null = null
  if (status) {
    const mods = p ? await loadCustomerModules(p, status.id).catch(() => null) : null
    moduleSection = { canAct: mods !== null && moduleActionsOffered(status.status, newestLite), enabled: mods?.enabled ?? [], available: mods?.available ?? [] }
  }
  // the dry run's report: the events of the newest reconcile request once it has ended
  let reconcileEvents: EventLine[] = []
  if (p && newest && newest.kind === 'reconcile' && latest && !latest.active) reconcileEvents = await requestEvents(p, newest.id).catch(() => [])
  return { slug: params.slug, status, requests, latest, refresh, offer, moduleSection, reconcileEvents }
}

// "Mandant sperren" / "Mandant fortsetzen": a suspend or resume REQUEST (TRD-044), only in the state that
// offers it (409 otherwise), with the operator's signed sign-in as evidence.
const lifecycleAction =
  (kind: LifecycleKind) =>
  async ({ params, request, locals }: { params: { slug: string }; request: Request; locals: App.Locals }) => {
    if (!SLUG.test(params.slug) || params.slug.length > 30) error(404, 'no such customer')
    const r = loadConfig(env)
    if (!r.ok) error(503, 'the control panel is not configured')
    if (!locals.operator) error(403, 'not signed in through the ops realm')
    const p = platformDb(r.config)
    if (!p) return fail(409, { lifecycleError: 'Keine Plattform-Datenbank konfiguriert: es kann keine Anfrage gestellt werden.' })
    const evidence = await evidenceFromRequest(request, r.config)
    if (!evidence) return fail(403, { lifecycleError: 'Die Anmeldung trägt keinen Nachweis (loa2). Bitte neu anmelden.' })
    const status = await customerStatus(r.config, params.slug).catch(() => null)
    try {
      await submitLifecycle(p, kind, params.slug, status?.status ?? null, locals.operator.id, evidence)
    } catch (err) {
      if (err instanceof SubmitRefused) return fail(err.status, { lifecycleError: err.message })
      throw err
    }
    redirect(303, `/customers/${params.slug}`)
  }

/** A text field of the form, trimmed; absent or a file part is the empty string. */
function field(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

// "Module": enable_module, disable_module, record_dpia and reconcile are REQUESTS (TRD-044), only for an
// active customer without a queued or running request (409 otherwise), with the operator's signed
// sign-in as evidence. A module must be one the section offers (409), the DPIA answer explicit (400).
const moduleAction =
  (kind: ModuleKind) =>
  async ({ params, request, locals }: { params: { slug: string }; request: Request; locals: App.Locals }) => {
    if (!SLUG.test(params.slug) || params.slug.length > 30) error(404, 'no such customer')
    const r = loadConfig(env)
    if (!r.ok) error(503, 'the control panel is not configured')
    if (!locals.operator) error(403, 'not signed in through the ops realm')
    const p = platformDb(r.config)
    if (!p) return fail(409, { moduleError: 'Keine Plattform-Datenbank konfiguriert: es kann keine Anfrage gestellt werden.' })
    const evidence = await evidenceFromRequest(request, r.config)
    if (!evidence) return fail(403, { moduleError: 'Die Anmeldung trägt keinen Nachweis (loa2). Bitte neu anmelden.' })
    const status = await customerStatus(r.config, params.slug).catch(() => null)
    if (!status) return fail(409, { moduleError: 'Es gibt keinen Mandanten mit diesem Kurznamen.' })
    const form = await request.formData()
    const module = field(form, 'module')
    let args: Record<string, unknown>
    if (kind === 'reconcile') {
      args = moduleArgs.reconcile(params.slug, field(form, 'apply') === 'true')
    } else {
      const mods = await loadCustomerModules(p, status.id).catch(() => null)
      if (!mods) return fail(503, { moduleError: 'Die Module des Mandanten sind nicht lesbar (Plattform-Datenbank; Details im Panel-Log).' })
      if (kind === 'enable_module') {
        const offered = mods.available.find((m) => m.id === module)
        if (!offered || offered.denied !== null) return fail(409, { moduleError: offered?.denied ?? 'Dieses Modul kann nicht aktiviert werden (unbekannt oder bereits aktiv).' })
        const d = parseDpiaForm(field(form, 'dpia'), field(form, 'dpiaRef'))
        if (!d.ok) return fail(400, { moduleError: `${module}: ${d.error}` })
        args = moduleArgs.enable(params.slug, module, d)
      } else {
        if (!mods.enabled.some((m) => m.id === module)) return fail(409, { moduleError: 'Dieses Modul ist für den Mandanten nicht aktiv.' })
        if (kind === 'disable_module') {
          args = moduleArgs.disable(params.slug, module)
        } else {
          const d = parseDpiaForm(field(form, 'dpia'), field(form, 'dpiaRef'))
          if (!d.ok) return fail(400, { moduleError: `${module}: ${d.error}` })
          args = moduleArgs.recordDpia(params.slug, module, d)
        }
      }
    }
    try {
      await submitModuleRequest(p, kind, params.slug, status.status, args, locals.operator.id, evidence)
    } catch (err) {
      if (err instanceof SubmitRefused) return fail(err.status, { moduleError: err.message })
      throw err
    }
    redirect(303, `/customers/${params.slug}`)
  }

export const actions: Actions = {
  suspend: lifecycleAction('suspend'),
  resume: lifecycleAction('resume'),
  enable_module: moduleAction('enable_module'),
  disable_module: moduleAction('disable_module'),
  record_dpia: moduleAction('record_dpia'),
  reconcile: moduleAction('reconcile'),
  retry: async ({ params, request, locals }) => {
    if (!SLUG.test(params.slug) || params.slug.length > 30) error(404, 'no such customer')
    const r = loadConfig(env)
    if (!r.ok) error(503, 'the control panel is not configured')
    if (!locals.operator) error(403, 'not signed in through the ops realm')
    const p = platformDb(r.config)
    if (!p) return fail(409, { retryError: 'Keine Plattform-Datenbank konfiguriert: es kann keine Anfrage gestellt werden.' })
    const evidence = await evidenceFromRequest(request, r.config)
    if (!evidence) return fail(403, { retryError: 'Die Anmeldung trägt keinen Nachweis (loa2). Bitte neu anmelden.' })
    try {
      await retryRequest(p, params.slug, locals.operator.id, evidence)
    } catch (err) {
      if (err instanceof SubmitRefused) return fail(err.status, { retryError: err.message })
      throw err
    }
    redirect(303, `/customers/${params.slug}`)
  },
}
