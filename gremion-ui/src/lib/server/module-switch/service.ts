// src/lib/server/module-switch/service.ts
// Karenz phase 1, Task 11: the council module switch.
//
// A council admin switches a module ON from the settings page. The request goes through the platform
// queue (plt.submit_council_module_request, as the least-privilege role gremion_ui_modules) carrying the
// admin's signed loa2 token pair; the host executor re-verifies that evidence against the council's own
// realm and runs the unchanged enable_module handler. Nothing here edits config.modules: the reconciler
// (Task 13) applies the result once the request has succeeded.
//
// Switch-OFF is reachable since the 30-day Karenz exists (phase 2, Task 17): COUNCIL_DISABLE_ALLOWED in
// @gremion/provisioning is true, and a disable blocks the module database instead of dropping it. A caller
// or a test may still inject `disableAllowed: false` to get the phase 1 refusal DISABLE_NOT_YET back.
//
// The Karenz row of the module (plt.council_karenz_list, the platform clock) decides two more things:
//   - an enable while the row is `finalizing` is refused KARENZ_FINALIZING: the day-30 job is deleting, a
//     switch-on must never half restore;
//   - an enable while the row is `open` IS the restore (the same enable_module request), and the DPIA
//     decision was recorded when the module was first switched on, so no new input is asked for;
//   - a disable while the row is `restoring` is refused RESTORE_PENDING: locked items must not be adopted by
//     a second Karenz before the first restore is finished.
//
// Guard order: role, step-up, input shape, disable flag, deny by name, build exclusion, switchable set,
// shipped, Karenz state (finalizing, restoring), no-op, confirmation phrase (disable), module switch-off
// guard (disable), DPIA decision (enable, not for a restore), then the platform submit, the tenant-side
// record and the audit entry.
import { randomUUID } from 'node:crypto'
import { COUNCIL_DISABLE_ALLOWED } from '@gremion/provisioning'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { evaluateStepUp } from '$lib/auth/step-up'
import { confirmationMatches, manifestIdOf, SWITCHABLE_CATALOGUE_IDS, TOGGLEABLE_PAIRS } from '$lib/modules/catalogue-map'
import { isHeldOffModule } from '$lib/modules/held-off'
import type { KarenzView, ModuleOverview, ModuleOverviewItem } from '$lib/modules/switch-preview'
import { writeAuditEntry } from '$lib/server/audit-db'
import { readConfig } from '$lib/server/config'
import { listKarenz as realListKarenz, type KarenzRowView } from '$lib/server/module-karenz/platform'
import type { TenantContext } from '$lib/server/tenant/context'
import { encodeEvidence, EVIDENCE_SKEW_SECONDS, EVIDENCE_WINDOW_SECONDS, idTokenSignInTime } from '$lib/server/tenant/provisioner/request-verify'
import { CouncilNotConfigured, getCouncilDb } from './council-db'
import { switchOffBlockedReason } from './guards'
import { buildKarenzView, type KarenzViewDeps } from './karenz-view'
import { insertSwitch, listSwitches, type SwitchRow } from './store'
import { MODULE_SWITCH_REQUIRED_LOA, moduleSwitchStepUpFreshnessSeconds } from './step-up'

export interface SwitchInput {
  moduleId: string
  action: 'enable' | 'disable'
  confirm?: string
  dpia?: { requiresDpia: boolean; documentRef: string }
}

export type SwitchResult =
  | { ok: true; requestId: string }
  | { ok: false; status: 400 | 401 | 403 | 409 | 422 | 503; code: string; message: string }

/**
 * Mirror of @gremion/provisioning DENY_REASONS: the modules refused by name. Kept here as the text the
 * settings page shows; the unit test pins it equal to the provisioning list, as the control panel does.
 */
export const MODULE_DENY: Readonly<Record<string, string>> = Object.freeze({
  board: 'it is not tenant-isolated yet (R29-I1; TASK-058 / R29-BOARD-STORE-K)',
  vault: 'the password vault stays off for the pilot (PRD-PLAT-012 / PRD-REC-003) until its own isolation pass (TRD-064, TASK-058)',
})

export interface SwitchContext {
  tenant: TenantContext
  user: SessionUser
  /** Session tokens (server side only): the pair the executor re-verifies. */
  idToken: string
  accessToken: string
}

export interface SwitchDeps {
  /** Defaults to COUNCIL_DISABLE_ALLOWED (true since the Karenz, phase 2). */
  disableAllowed?: boolean
  /** The live Karenz rows of the customer; defaults to the platform list (plt.council_karenz_list). */
  listKarenz?: (customerId: string) => Promise<KarenzRowView[]>
  /** Ids from modules/disabled.json when the caller knows them (the executor re-checks against the file). */
  disabledIds?: readonly string[]
  /** Clock and key sources, injectable for tests. */
  nowMs?: () => number
  newKey?: () => string
}

/** The DPIA reason code of a council decision (the executor refuses any other for this origin). */
const COUNCIL_REASON_CODE = 'council_decision'

/**
 * The text rule of a document reference: printable, no controls, no bidi controls, no line separators, no lone
 * surrogates. A mirror of @gremion/provisioning printable-text.ts and of the panel's rule (the executor
 * refuses what this lets through, so the admin sees the reason here first).
 */
function isPrintable(s: string): boolean {
  if (s.length === 0) return false
  // for..of yields a valid surrogate pair as ONE code point and a lone surrogate on its own (in the refused range).
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const refused =
      c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || (c >= 0xd800 && c <= 0xdfff)
    if (refused) return false
  }
  return true
}

const fail = (status: 400 | 401 | 403 | 409 | 422 | 503, code: string, message: string): SwitchResult => ({ ok: false, status, code, message })

/** Who may switch modules: council-admin, and it-admin through the role hierarchy. */
export function mayManageModules(user: SessionUser | null | undefined): user is SessionUser {
  return !!user && hasRole(user.roles, Role.CouncilAdmin)
}

interface StateRow {
  module_key: string
  name: string
  state: string
  has_row: boolean
  dpia_recorded: boolean
}

type Platform = ReturnType<typeof getCouncilDb>

async function readState(platform: Platform, tenant: TenantContext): Promise<Map<string, StateRow>> {
  const rows = await platform<StateRow[]>`SELECT module_key, name, state, has_row, dpia_recorded FROM plt.council_module_state(${tenant.id}::uuid)`
  return new Map(rows.map((r) => [r.module_key, r]))
}

const LIVE_KARENZ = new Set<KarenzRowView['state']>(['open', 'restoring', 'finalizing'])

/** The newest live Karenz row (open, restoring, finalizing) of one catalogue id, or undefined. */
function liveKarenzOf(rows: readonly KarenzRowView[], catalogueId: string): KarenzRowView | undefined {
  let newest: KarenzRowView | undefined
  for (const r of rows) {
    if (r.catalogueId !== catalogueId || !LIVE_KARENZ.has(r.state)) continue
    if (!newest || r.switchedOffAt.getTime() > newest.switchedOffAt.getTime()) newest = r
  }
  return newest
}

/** The value config.modules holds for a manifest id: absent reads as on (every toggleable manifest defaults to true). */
function configOn(modules: Record<string, boolean> | undefined, manifestId: string): boolean {
  return modules?.[manifestId] !== false
}

function validDpia(d: unknown): d is { requiresDpia: boolean; documentRef: string } {
  if (typeof d !== 'object' || d === null) return false
  const { requiresDpia, documentRef } = d as { requiresDpia?: unknown; documentRef?: unknown }
  if (typeof requiresDpia !== 'boolean' || typeof documentRef !== 'string') return false
  const ref = documentRef.trim()
  return ref !== '' && ref.length <= 500 && isPrintable(ref) && !ref.startsWith('-')
}

function mapPlatformError(err: unknown): SwitchResult {
  if (err instanceof CouncilNotConfigured) return fail(503, 'NOT_CONFIGURED', 'Modulschalter nicht konfiguriert.')
  const code = (err as { code?: unknown } | null)?.code
  if (code === '55006') return fail(409, 'IN_FLIGHT', 'Für diesen Mandanten läuft bereits eine Anfrage. Bitte warten, bis sie abgeschlossen ist.')
  if (code === '28000') return fail(401, 'STEP_UP_REQUIRED', 'Bitte erneut anmelden und die Zwei-Faktor-Prüfung wiederholen.')
  if (code === '22023') {
    // The UI-side checks mirror the platform's, so this means the two have drifted: log the reason (never shown).
    console.warn('[module-switch] platform rejected the input:', err instanceof Error ? err.message : err)
    return fail(422, 'INVALID', 'Die Anfrage wurde von der Plattform als ungültig abgelehnt.')
  }
  // The detail (hosts, SQL text) goes to the log, never to the browser.
  console.error('[module-switch] platform submit failed:', code ?? '', err instanceof Error ? err.message : err)
  return fail(503, 'PLATFORM_ERROR', 'Die Anfrage konnte nicht an die Plattform übergeben werden. Bitte später erneut versuchen.')
}

export async function submitModuleSwitch(ctx: SwitchContext, input: SwitchInput, deps: SwitchDeps = {}): Promise<SwitchResult> {
  const { tenant, user } = ctx
  if (!mayManageModules(user)) return fail(403, 'FORBIDDEN', 'Nur Administratorinnen und Administratoren dürfen Module schalten.')

  const decision = evaluateStepUp({ loa: user.loa, authTime: user.authTime }, MODULE_SWITCH_REQUIRED_LOA, {
    nowMs: (deps.nowMs ?? Date.now)(),
    freshnessSeconds: moduleSwitchStepUpFreshnessSeconds(),
  })
  if (!decision.ok) return fail(401, 'STEP_UP_REQUIRED', 'Bitte die Zwei-Faktor-Prüfung wiederholen.')

  const raw = input as Partial<SwitchInput> | null
  if (typeof raw !== 'object' || raw === null || typeof raw.moduleId !== 'string' || raw.moduleId === '' || raw.moduleId.length > 64) {
    return fail(400, 'BAD_INPUT', 'moduleId fehlt oder ist ungültig.')
  }
  if (raw.action !== 'enable' && raw.action !== 'disable') return fail(400, 'BAD_INPUT', 'action muss enable oder disable sein.')
  if (raw.confirm !== undefined && typeof raw.confirm !== 'string') return fail(400, 'BAD_INPUT', 'confirm muss ein Text sein.')
  const { moduleId, action, confirm, dpia } = raw as SwitchInput

  // The switch-off can be turned off again (injected, or the constant): nothing is queued, the platform is not asked.
  if (action === 'disable' && !(deps.disableAllowed ?? COUNCIL_DISABLE_ALLOWED)) {
    return fail(422, 'DISABLE_NOT_YET', 'Das Ausschalten von Modulen ist noch nicht freigegeben. Es folgt mit der 30-Tage-Frist.')
  }
  if (Object.hasOwn(MODULE_DENY, moduleId)) return fail(422, 'MODULE_DENIED', `Das Modul ${moduleId} kann nicht eingeschaltet werden: ${MODULE_DENY[moduleId]}.`)
  // A held-off module (elections) is pinned false in config.modules, so an enable would pass the platform and then
  // never take effect. Refused here, before anything is queued; a disable is a no-op the checks below already answer.
  if (action === 'enable' && isHeldOffModule(moduleId)) {
    return fail(422, 'MODULE_HELD_OFF', `Das Modul ${moduleId} ist für diese Installation nicht freigegeben und kann nicht eingeschaltet werden.`)
  }
  if ((deps.disabledIds ?? []).includes(moduleId)) {
    return fail(422, 'MODULE_NOT_SHIPPED', `Das Modul ${moduleId} ist in dieser Installation nicht enthalten (modules/disabled.json).`)
  }
  if (!SWITCHABLE_CATALOGUE_IDS.has(moduleId)) {
    return fail(422, 'MODULE_NOT_SWITCHABLE', `Das Modul ${moduleId} kann nicht von der Gremiumsverwaltung geschaltet werden.`)
  }
  const manifestId = manifestIdOf(moduleId)
  const pair = TOGGLEABLE_PAIRS.find((p) => p.catalogueId === moduleId)
  if (manifestId === null || !pair) {
    return fail(422, 'MODULE_NOT_SHIPPED', `Das Modul ${moduleId} ist in dieser Installation nicht enthalten.`)
  }

  // The sign-in time the platform records must be the ID token's OWN (auth_time, else iat): the executor compares
  // the recorded value with that claim within 1 s, and user.authTime is the gremion-ui server's clock at the jwt
  // callback (a different instant). The token also has to lie inside the evidence window, or the executor would
  // refuse it later: a new sign-in is the remedy, said now.
  const signedIn = idTokenSignInTime(ctx.idToken)
  const ageSeconds = signedIn === null ? null : Math.floor((deps.nowMs ?? Date.now)() / 1000) - signedIn.seconds
  if (signedIn === null || ageSeconds === null || ageSeconds > EVIDENCE_WINDOW_SECONDS || ageSeconds < -EVIDENCE_SKEW_SECONDS) {
    return fail(401, 'STEP_UP_REQUIRED', 'Bitte erneut anmelden und die Zwei-Faktor-Prüfung wiederholen.')
  }

  let platform: Platform
  let state: Map<string, StateRow>
  try {
    platform = getCouncilDb()
    state = await readState(platform, tenant)
  } catch (err) {
    return mapPlatformError(err)
  }
  const stateRow = state.get(moduleId)
  if (!stateRow) return fail(422, 'MODULE_NOT_SHIPPED', `Das Modul ${moduleId} ist im Modulkatalog der Plattform nicht vorhanden.`)

  // The module's live Karenz row, if any. Unreadable is not "none": a switch that cannot see whether the
  // day-30 job is deleting must not be queued (fail closed).
  let karenz: KarenzRowView | undefined
  try {
    karenz = liveKarenzOf(await (deps.listKarenz ?? ((id) => realListKarenz(id, 0)))(tenant.id), moduleId)
  } catch (err) {
    return mapPlatformError(err)
  }
  if (action === 'enable' && karenz?.state === 'finalizing') {
    return fail(409, 'KARENZ_FINALIZING', `Die endgültige Löschung von ${pair.label} läuft gerade. Das Modul kann erst danach neu eingeschaltet werden.`)
  }

  // No-op: the platform state AND config.modules must both already say so. When they disagree the request is
  // queued and the reconciler writes the platform truth where a platform row exists.
  const platformOn = stateRow.state === 'enabled'
  const cfgOn = configOn(readConfig(tenant).modules, manifestId)
  if (action === 'enable' && platformOn && cfgOn) return fail(409, 'NOOP', `${pair.label} ist bereits eingeschaltet.`)
  if (action === 'disable' && !platformOn && !cfgOn) return fail(409, 'NOOP', `${pair.label} ist bereits ausgeschaltet.`)

  if (action === 'disable' && karenz?.state === 'restoring') {
    return fail(409, 'RESTORE_PENDING', `${pair.label} wird gerade wiederhergestellt. Bitte warten, bis das abgeschlossen ist, bevor es erneut ausgeschaltet wird.`)
  }

  if (action === 'disable' && !confirmationMatches(confirm, pair.label)) {
    return fail(422, 'CONFIRM_MISMATCH', `Zur Bestätigung den Namen des Moduls genau so eingeben: ${pair.label}`)
  }

  // The module may object to being switched off right now (an election that cannot be paused). A guard that
  // fails objects too; only the reason text reaches the admin.
  if (action === 'disable') {
    const reason = await switchOffBlockedReason(tenant, moduleId)
    if (reason !== null) return fail(409, 'SWITCH_OFF_BLOCKED', reason)
  }

  let args: Record<string, unknown> = { slug: tenant.slug, module: moduleId }
  if (action === 'enable') {
    if (dpia !== undefined && dpia !== null) {
      if (!validDpia(dpia)) {
        return fail(422, 'DPIA_INVALID', 'Die DPIA-Entscheidung braucht eine Ja/Nein-Angabe und einen Dokumentverweis (höchstens 500 Zeichen, keine Steuerzeichen, kein Bindestrich am Anfang).')
      }
      args = {
        ...args,
        dpia: { requires_dpia: dpia.requiresDpia, reason_codes: [COUNCIL_REASON_CODE], document_ref: dpia.documentRef.trim() },
      }
    } else if (!stateRow.dpia_recorded && karenz?.state !== 'open') {
      // (an open Karenz is the restore of a module that was switched on before: its decision is on record)
      return fail(422, 'DPIA_REQUIRED', 'Für dieses Modul liegt noch keine DPIA-Entscheidung vor. Bitte die Entscheidung mit Dokumentverweis angeben.')
    }
  }

  let requestId: string
  try {
    const key = (deps.newKey ?? randomUUID)()
    const authTime = new Date(signedIn.seconds * 1000).toISOString()
    const rows = await platform<{ request_id: string }[]>`
      SELECT plt.submit_council_module_request(
        ${action === 'enable' ? 'enable_module' : 'disable_module'}, ${tenant.slug}, ${platform.json(args as Parameters<typeof platform.json>[0])}::jsonb,
        ${key}::uuid, ${user.id}::uuid, ${'loa2'}, ${authTime}::timestamptz,
        ${encodeEvidence({ id: ctx.idToken, access: ctx.accessToken })})::text AS request_id`
    const id = rows[0]?.request_id
    if (!id) throw new Error('the platform returned no request id')
    requestId = id
  } catch (err) {
    return mapPlatformError(err)
  }

  // The platform accepted. From here nothing turns the answer into a failure: the request exists and will run.
  try {
    await insertSwitch(tenant.db, { requestId, moduleId, action, actorUserId: user.id })
  } catch (err) {
    console.error(`[module-switch] request ${requestId} (${action} ${moduleId}) was queued but the tenant-side record failed; the reconciler adopts it:`, err instanceof Error ? err.message : err)
  }
  try {
    await writeAuditEntry({
      userId: user.id,
      field: 'module.switch.requested',
      oldValue: null,
      newValue: `module=${moduleId} action=${action} request=${requestId}`,
    })
  } catch (err) {
    // The platform-side request row (it carries the acting person) is the fallback record of this switch.
    console.error(`[module-switch] tenant audit write failed for request ${requestId}; the platform request row is the fallback record:`, err instanceof Error ? err.message : err)
  }
  return { ok: true, requestId }
}

const FAILED_STATES = new Set<SwitchRow['state']>(['failed', 'refused', 'expired', 'dead'])
const PENDING_STATES = new Set<SwitchRow['state']>(['queued', 'succeeded', 'applying'])

/** The failure text of a module's newest switch row, or null when the newest row is not a failure. */
function lastFailureOf(rows: readonly SwitchRow[]): string | null {
  const newest = rows[0]
  if (!newest) return null
  if (FAILED_STATES.has(newest.state)) return newest.outcome ?? 'Die Anfrage wurde nicht ausgeführt.'
  // The platform step succeeded but config.json could not be written: still applying, with the error visible.
  if (PENDING_STATES.has(newest.state) && newest.configError) return newest.configError
  return null
}

export interface OverviewDeps {
  /** The live Karenz rows of the customer; defaults to the platform list. */
  listKarenz?: (customerId: string) => Promise<KarenzRowView[]>
  /** What the Karenz view reads (tests inject doubles). */
  karenz?: Partial<KarenzViewDeps>
}

/** The Karenz views of the tenant's switchable modules, keyed by catalogue id; null when the platform list cannot be read. */
async function loadKarenzViews(tenant: TenantContext, deps: OverviewDeps): Promise<Map<string, KarenzView> | null> {
  try {
    const rows = await (deps.listKarenz ?? ((id) => realListKarenz(id, 0)))(tenant.id)
    const views = new Map<string, KarenzView>()
    for (const pair of TOGGLEABLE_PAIRS) {
      const row = liveKarenzOf(rows, pair.catalogueId)
      if (row) views.set(pair.catalogueId, await buildKarenzView(tenant, row, deps.karenz))
    }
    return views
  } catch (err) {
    console.error('[module-switch] the Karenz rows could not be loaded:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function loadModuleOverview(tenant: TenantContext, deps: OverviewDeps = {}): Promise<ModuleOverview> {
  const platform = getCouncilDb()
  const state = await readState(platform, tenant)
  const modules = readConfig(tenant).modules

  let switches: SwitchRow[] = []
  const problems: string[] = []
  try {
    switches = await listSwitches(tenant.db, 100)
  } catch (err) {
    console.error('[module-switch] switch history unreadable:', err instanceof Error ? err.message : err)
    problems.push('Der Verlauf der Modulanfragen konnte nicht geladen werden.')
  }
  const karenzViews = await loadKarenzViews(tenant, deps)
  if (karenzViews === null) problems.push('Der Stand der 30-Tage-Frist konnte nicht geladen werden.')

  // A held-off module is invisible here: a row with an enable button that can never take effect is a lie.
  const items: ModuleOverviewItem[] = TOGGLEABLE_PAIRS.filter((pair) => !isHeldOffModule(pair.manifestId)).map((pair) => {
    const row = state.get(pair.catalogueId)
    const managed = row?.has_row === true
    const rows = switches.filter((s) => s.moduleId === pair.catalogueId)
    return {
      moduleId: pair.catalogueId,
      label: pair.label,
      enabled: managed ? row!.state === 'enabled' : configOn(modules, pair.manifestId),
      managed,
      dpiaRecorded: row?.dpia_recorded === true,
      denied: MODULE_DENY[pair.catalogueId] ?? null,
      pending: rows.filter((s) => PENDING_STATES.has(s.state)).map((s) => ({ requestId: s.requestId, action: s.action, state: s.state })),
      lastFailure: lastFailureOf(rows),
      karenz: karenzViews?.get(pair.catalogueId) ?? null,
    }
  }).sort((a, b) => a.moduleId.localeCompare(b.moduleId))

  return { modules: items, disableAvailable: COUNCIL_DISABLE_ALLOWED, problem: problems.length > 0 ? problems.join(' ') : null }
}
