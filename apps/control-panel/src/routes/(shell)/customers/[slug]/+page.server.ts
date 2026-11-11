// One customer: its control row and, when configured, its provisioning ledger
// in EXECUTION_ORDER (the progress "Neuer Mandant" shows) -- and the state of
// its NEWEST request, which exists before the customer does (queued,
// verifying, running with its step, failed, refused). "Erneut versuchen" is a
// new request with a new idempotency key, only after failed/refused.
import { error, fail, redirect, type ActionFailure } from '@sveltejs/kit'
import { env } from '$env/dynamic/private'
import { lifecycleOffer, type LifecycleKind } from '$lib/lifecycle'
import { isKnownVertical, redactAddresses, VERTICALS } from '$lib/members'
import { DISABLE_LOCKED, moduleActionsOffered, type ModuleKind } from '$lib/modules'
import { describeRequest } from '$lib/request-state'
import { evidenceFromRequest } from '$lib/server/auth'
import { loadConfig } from '$lib/server/config'
import { customerRequests, customerStatus, platformDb } from '$lib/server/customers'
import { submitLifecycle } from '$lib/server/lifecycle'
import { LIST_TOO_BIG, loadImportState, memberArgs, readCsvList, submitMemberRequest, type ImportState, type MemberKind, type ValidatedList } from '$lib/server/members'
import { loadCustomerModules, moduleArgs, parseDpiaForm, requestEvents, submitModuleRequest, type CustomerModules, type EventLine } from '$lib/server/modules'
import { SubmitRefused } from '$lib/server/requests'
import { retryRequest } from '$lib/server/retry'
import type { Actions, PageServerLoad } from './$types'

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** A failed read, for the panel log: what was read and the SQLSTATE or message of the error (never form or list content). */
function logRead(what: string, err: unknown): void {
  const e = err as { code?: string; message?: string }
  console.error(`[control-panel] ${what} read failed: ${e?.code ?? 'no-sqlstate'}: ${e?.message ?? String(err)}`)
}

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
  // the "Vertikale und Mitglieder" section: the verticals, whether an action can be queued now, the list the
  // newest validate accepted (the apply is offered only for it) and the events of the newest ended import request
  // `unreadable`: the import state could not be read (logged); no action is offered then, and the page says so
  // instead of looking as if no validate ever ran.
  let memberSection: { canAct: boolean; unreadable: boolean; noPlatformDb: boolean; verticals: typeof VERTICALS; validated: ValidatedList | null; importEvents: EventLine[] } | null = null
  if (status) {
    let st: ImportState | null = null
    let unreadable = false
    if (p) {
      try {
        st = await loadImportState(p, params.slug)
      } catch (err) {
        logRead(`import state ${params.slug}`, err)
        unreadable = true
      }
    }
    memberSection = {
      canAct: p !== null && !unreadable && moduleActionsOffered(status.status, newestLite),
      unreadable,
      noPlatformDb: p === null,
      verticals: VERTICALS,
      validated: st?.validated ?? null,
      importEvents: st?.events ?? [],
    }
  }
  // the dry run's report: the events of the newest reconcile request once it has ended
  let reconcileEvents: EventLine[] = []
  if (p && newest && newest.kind === 'reconcile' && latest && !latest.active) reconcileEvents = await requestEvents(p, newest.id).catch(() => [])
  // the cause of a failure: the newest ended request of ANY kind that failed or was refused shows its events (the
  // newest 60, like the reconcile block; the executor stores every handler line already redacted, addresses are
  // cut again here). Reconcile and import_members already show theirs in their own section.
  let failureEvents: EventLine[] = []
  if (p && newest && latest && (latest.phase === 'failed' || latest.phase === 'refused') && newest.kind !== 'reconcile' && newest.kind !== 'import_members') {
    failureEvents = (await requestEvents(p, newest.id).catch(() => [])).map((e) => ({ level: e.level, step: e.step, message: redactAddresses(e.message) }))
  }
  return { slug: params.slug, status, requests, latest, refresh, offer, moduleSection, memberSection, reconcileEvents, failureEvents }
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
          if (DISABLE_LOCKED.has(module)) return fail(409, { moduleError: 'Dieses Modul kann bis zum Abgleich der Leaf-Datenbanken nicht deaktiviert werden.' })
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

type MemberEvent = { params: { slug: string }; request: Request; locals: App.Locals }

/**
 * The checks every member action shares, in the neighbours' order: the slug, the configuration, the signed-in
 * operator (403), the platform database, the operator's signed sign-in as evidence (the step-up rule), and a
 * customer that exists. `failed` is the refusal to return; otherwise the context to queue with.
 */
async function memberContext({ params, request, locals }: MemberEvent) {
  if (!SLUG.test(params.slug) || params.slug.length > 30) error(404, 'no such customer')
  const r = loadConfig(env)
  if (!r.ok) error(503, 'the control panel is not configured')
  if (!locals.operator) error(403, 'not signed in through the ops realm')
  const p = platformDb(r.config)
  if (!p) return { failed: fail(409, { memberError: 'Keine Plattform-Datenbank konfiguriert: es kann keine Anfrage gestellt werden.' }) }
  const evidence = await evidenceFromRequest(request, r.config)
  if (!evidence) return { failed: fail(403, { memberError: 'Die Anmeldung trägt keinen Nachweis (loa2). Bitte neu anmelden.' }) }
  let status: Awaited<ReturnType<typeof customerStatus>>
  try {
    status = await customerStatus(r.config, params.slug)
  } catch (err) {
    logRead(`customer status ${params.slug}`, err)
    return { failed: fail(503, { memberError: 'Der Mandant ist nicht lesbar (Kontroll-Registry oder Plattform-Datenbank; Details im Panel-Log).' }) }
  }
  if (!status) return { failed: fail(409, { memberError: 'Es gibt keinen Mandanten mit diesem Kurznamen.' }) }
  return { p, evidence, status, operatorId: locals.operator.id, slug: params.slug, failed: null }
}
/** The one failure shape of the member actions (a concrete type: ReturnType of the overloaded fail() is ActionFailure<unknown> and would erase ActionData). */
type MemberFailure = ActionFailure<{ memberError: string }>
type MemberContext = Exclude<Awaited<ReturnType<typeof memberContext>>, { failed: MemberFailure }>

const UNREADABLE_FORM = 'Das Formular konnte nicht gelesen werden. Bitte die Seite neu laden.'

/** The form of the request, or the refusal to return: 413 when the server's body limit stopped it, else 400 (logged by type and status only). */
async function memberForm(request: Request): Promise<{ form: FormData; failed: null } | { form: null; failed: MemberFailure }> {
  try {
    return { form: await request.formData(), failed: null }
  } catch (err) {
    const e = err as { status?: number; name?: string }
    if (e?.status === 413) return { form: null, failed: fail(413, { memberError: LIST_TOO_BIG }) }
    console.error(`[control-panel] member form unreadable: ${e?.name ?? 'Error'}${e?.status ? ` (${e.status})` : ''}`)
    return { form: null, failed: fail(400, { memberError: UNREADABLE_FORM }) }
  }
}

async function queueMember(c: MemberContext, kind: MemberKind, args: Record<string, unknown>) {
  try {
    await submitMemberRequest(c.p, kind, c.slug, c.status.status, args, c.operatorId, c.evidence)
  } catch (err) {
    // a 503 is already in the panel log (submitRefusal writes name and SQLSTATE, never the message, which could carry list content)
    if (err instanceof SubmitRefused) return fail(err.status, { memberError: err.message })
    throw err
  }
  redirect(303, `/customers/${c.slug}`)
}

// "Vertikale und Mitglieder": seed_vertical, and import_members in two phases, are REQUESTS (TRD-044 gate: an
// active customer without a queued or running request, 409 otherwise), with the operator's signed sign-in as
// evidence. The list is checked here (size, text) and never echoed; the apply names the sha256 the VALIDATE
// reported, read from that request's events on the server, never taken from the form.
const seedVertical = async (e: MemberEvent) => {
  const c = await memberContext(e)
  if (c.failed) return c.failed
  const f = await memberForm(e.request)
  if (f.failed) return f.failed
  const vertical = field(f.form, 'vertical')
  if (!isKnownVertical(vertical)) return fail(400, { memberError: 'Unbekannte Vertikale: bitte eine der angebotenen wählen.' })
  return queueMember(c, 'seed_vertical', memberArgs.seed(c.slug, vertical))
}

const importValidate = async (e: MemberEvent) => {
  const c = await memberContext(e)
  if (c.failed) return c.failed
  const f = await memberForm(e.request)
  if (f.failed) return f.failed
  const vertical = field(f.form, 'vertical')
  if (!isKnownVertical(vertical)) return fail(400, { memberError: 'Unbekannte Vertikale: bitte eine der angebotenen wählen.' })
  const list = await readCsvList(f.form)
  if (!list.ok) return fail(list.status, { memberError: list.error })
  return queueMember(c, 'import_members', memberArgs.validate(c.slug, vertical, list.csv))
}

const importApply = async (e: MemberEvent) => {
  const c = await memberContext(e)
  if (c.failed) return c.failed
  const f = await memberForm(e.request)
  if (f.failed) return f.failed
  const form = f.form
  let validated: ValidatedList | null
  try {
    validated = (await loadImportState(c.p, c.slug)).validated
  } catch (err) {
    logRead(`import state ${c.slug}`, err)
    return fail(503, { memberError: 'Der Stand der Prüfung ist nicht lesbar (Plattform-Datenbank; Details im Panel-Log). Es wurde nichts eingespielt.' })
  }
  if (!validated) return fail(409, { memberError: 'Es gibt keine erfolgreiche Prüfung einer Mitgliederliste, die eingespielt werden könnte. Bitte die Liste zuerst prüfen.' })
  if (field(form, 'sha256') !== validated.sha256) return fail(409, { memberError: 'Die Prüfung hat sich seit dem Laden der Seite geändert. Bitte die Seite neu laden und das Ergebnis erneut ansehen.' })
  if (field(form, 'confirm') !== 'yes') return fail(400, { memberError: 'Bitte bestätigen, dass die Liste mit der angezeigten Prüfsumme jetzt eingespielt werden soll.' })
  const list = await readCsvList(form)
  if (!list.ok) return fail(list.status, { memberError: list.error })
  return queueMember(c, 'import_members', memberArgs.apply(c.slug, validated.vertical, list.csv, validated.sha256))
}

export const actions: Actions = {
  seedVertical,
  importValidate,
  importApply,
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
