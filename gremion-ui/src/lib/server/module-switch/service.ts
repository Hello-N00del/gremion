// src/lib/server/module-switch/service.ts
// Karenz phase 1, Task 11: the council module switch.
//
// A council admin switches a module ON from the settings page. The request goes through the platform
// queue (plt.submit_council_module_request, as the least-privilege role gremion_ui_modules) carrying the
// admin's signed loa2 token pair; the host executor re-verifies that evidence against the council's own
// realm and runs the unchanged enable_module handler. Nothing here edits config.modules: the reconciler
// (Task 13) applies the result once the request has succeeded.
//
// Switch-OFF is built (confirmation phrase, preview contract, branch) but unreachable: while
// COUNCIL_DISABLE_ALLOWED is false (phase 1) every council `disable` is refused DISABLE_NOT_YET before the
// platform is asked, because today's disableModule exports and then drops the module database at once.
// Phase 2 flips the one constant in @gremion/provisioning.
//
// Guard order: role, step-up, input shape, disable flag, deny by name, build exclusion, switchable set,
// shipped, no-op, confirmation phrase (disable), DPIA decision (enable), then the platform submit, the
// tenant-side record and the audit entry.
import { randomUUID } from 'node:crypto'
import { COUNCIL_DISABLE_ALLOWED } from '@gremion/provisioning'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { evaluateStepUp } from '$lib/auth/step-up'
import { confirmationMatches, manifestIdOf, SWITCHABLE_CATALOGUE_IDS, TOGGLEABLE_PAIRS } from '$lib/modules/catalogue-map'
import type { ModuleOverview, ModuleOverviewItem } from '$lib/modules/switch-preview'
import { writeAuditEntry } from '$lib/server/audit-db'
import { readConfig } from '$lib/server/config'
import type { TenantContext } from '$lib/server/tenant/context'
import { encodeEvidence, EVIDENCE_SKEW_SECONDS, EVIDENCE_WINDOW_SECONDS, idTokenSignInTime } from '$lib/server/tenant/provisioner/request-verify'
import { CouncilNotConfigured, getCouncilDb } from './council-db'
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
  /** Defaults to COUNCIL_DISABLE_ALLOWED (false in phase 1). */
  disableAllowed?: boolean
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

  // Phase 1: a council never switches a module off. Before anything else is asked, nothing is queued.
  if (action === 'disable' && !(deps.disableAllowed ?? COUNCIL_DISABLE_ALLOWED)) {
    return fail(422, 'DISABLE_NOT_YET', 'Das Ausschalten von Modulen ist noch nicht freigegeben. Es folgt mit der 30-Tage-Frist.')
  }
  if (Object.hasOwn(MODULE_DENY, moduleId)) return fail(422, 'MODULE_DENIED', `Das Modul ${moduleId} kann nicht eingeschaltet werden: ${MODULE_DENY[moduleId]}.`)
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

  // No-op: the platform state AND config.modules must both already say so. When they disagree the request is
  // queued and the reconciler writes the platform truth where a platform row exists.
  const platformOn = stateRow.state === 'enabled'
  const cfgOn = configOn(readConfig(tenant).modules, manifestId)
  if (action === 'enable' && platformOn && cfgOn) return fail(409, 'NOOP', `${pair.label} ist bereits eingeschaltet.`)
  if (action === 'disable' && !platformOn && !cfgOn) return fail(409, 'NOOP', `${pair.label} ist bereits ausgeschaltet.`)

  if (action === 'disable' && !confirmationMatches(confirm, pair.label)) {
    return fail(422, 'CONFIRM_MISMATCH', `Zur Bestätigung den Namen des Moduls genau so eingeben: ${pair.label}`)
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
    } else if (!stateRow.dpia_recorded) {
      return fail(422, 'DPIA_REQUIRED', 'Für dieses Modul liegt noch keine DPIA-Entscheidung vor. Bitte die Entscheidung mit Dokumentverweis angeben.')
    }
  }

  let requestId: string
  try {
    const key = (deps.newKey ?? randomUUID)()
    const authTime = new Date(signedIn.seconds * 1000).toISOString()
    const rows = await platform<{ request_id: string }[]>`
      SELECT plt.submit_council_module_request(
        ${action === 'enable' ? 'enable_module' : 'disable_module'}, ${tenant.slug}, ${JSON.stringify(args)}::jsonb,
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

export async function loadModuleOverview(tenant: TenantContext): Promise<ModuleOverview> {
  const platform = getCouncilDb()
  const state = await readState(platform, tenant)
  const modules = readConfig(tenant).modules

  let switches: SwitchRow[] = []
  let problem: string | null = null
  try {
    switches = await listSwitches(tenant.db, 100)
  } catch (err) {
    console.error('[module-switch] switch history unreadable:', err instanceof Error ? err.message : err)
    problem = 'Der Verlauf der Modulanfragen konnte nicht geladen werden.'
  }

  const items: ModuleOverviewItem[] = TOGGLEABLE_PAIRS.map((pair) => {
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
    }
  }).sort((a, b) => a.moduleId.localeCompare(b.moduleId))

  return { modules: items, disableAvailable: COUNCIL_DISABLE_ALLOWED, problem }
}
