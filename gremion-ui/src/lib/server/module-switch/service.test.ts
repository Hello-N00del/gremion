// @vitest-environment node
//
// Karenz phase 1, Task 11: the council module switch. A council admin switches a module ON through
// the platform request queue (plt.submit_council_module_request); a switch OFF was refused
// DISABLE_NOT_YET until phase 2 flipped COUNCIL_DISABLE_ALLOWED (it is queued now; the refusal stays
// reachable through the injected flag). The platform pool, the tenant store,
// the config and the audit writer are doubles; the guards, the order of the guards and the exact
// platform arguments are what these tests pin.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DENY_REASONS, COUNCIL_DISABLE_ALLOWED } from '@gremion/provisioning'
import { Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import type { TenantContext } from '$lib/server/tenant/context'

const h = vi.hoisted(() => ({
  getCouncilDb: vi.fn(),
  insertSwitch: vi.fn(),
  listSwitches: vi.fn(),
  readConfig: vi.fn(),
  writeAuditEntry: vi.fn(),
}))

vi.mock('./council-db', async (orig) => ({ ...(await orig<typeof import('./council-db')>()), getCouncilDb: h.getCouncilDb }))
vi.mock('./store', () => ({ insertSwitch: h.insertSwitch, listSwitches: h.listSwitches }))
vi.mock('$lib/server/config', () => ({ readConfig: h.readConfig }))
vi.mock('$lib/server/audit-db', () => ({ writeAuditEntry: h.writeAuditEntry }))
vi.mock('$env/dynamic/private', () => ({ env: {} }))

import { CouncilNotConfigured } from './council-db'
import { _clearSwitchOffGuardsForTests, registerSwitchOffGuard } from './guards'
import { calendarLeafSwitchOffGuard, LEAF_BACKED_SWITCH_OFF_REASON } from './leaf-guards'
import type { KarenzViewDeps } from './karenz-view'
import { MODULE_DENY, loadModuleOverview, submitModuleSwitch } from './service'

const CUSTOMER = '11111111-1111-4111-8111-111111111111'
const PERSON = '22222222-2222-4222-8222-222222222222'
const REQUEST = '33333333-3333-4333-8333-333333333333'
const KEY = '44444444-4444-4444-8444-444444444444'
const NOW_MS = Date.parse('2026-10-31T10:00:00Z')
const nowSec = Math.floor(NOW_MS / 1000)
// A decodable (unsigned) ID token: the service reads its sign-in time (auth_time, else iat) like the executor does.
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${'s'.repeat(40)}`
const ID_AUTH_TIME = nowSec - 17 // deliberately NOT the session's server-clock authTime (nowSec - 10)
const ID_TOKEN = jwt({ iat: nowSec - 40, auth_time: ID_AUTH_TIME, sid: 's-1' })
const ACCESS_TOKEN = 'access.' + 'a'.repeat(60)

const tenant = { id: CUSTOMER, slug: 'rat-a', db: { tenantDb: true } } as unknown as TenantContext

function user(over: Partial<SessionUser> = {}): SessionUser {
  return { id: PERSON, email: 'a@example.org', name: 'A', roles: [Role.CouncilAdmin], groups: [], loa: 2, authTime: nowSec - 10, ...over }
}
const ctx = (u: SessionUser = user(), idToken: string = ID_TOKEN) => ({ tenant, user: u, idToken, accessToken: ACCESS_TOKEN })
const deps = (extra: Record<string, unknown> = {}) => ({ nowMs: () => NOW_MS, newKey: () => KEY, ...extra })

interface StateRow {
  module_key: string
  name: string
  state: string
  has_row: boolean
  dpia_recorded: boolean
}
const row = (module_key: string, over: Partial<StateRow> = {}): StateRow => ({
  module_key,
  name: module_key,
  state: 'disabled',
  has_row: false,
  dpia_recorded: false,
  ...over,
})
// plt.module is catalogue-wide (every row is toggleable): the double returns the whole catalogue.
const CATALOGUE = ['board', 'calendar', 'elections', 'files', 'handover', 'messaging', 'publishing', 'votes', 'vault']

let platform: { calls: { text: string; values: unknown[] }[]; state: StateRow[]; karenz: Record<string, unknown>[]; submit: () => Promise<unknown[]> }

function installPlatform(state: StateRow[] = CATALOGUE.map((k) => row(k)), karenz: Record<string, unknown>[] = []) {
  platform = {
    calls: [],
    state,
    karenz,
    submit: async () => [{ request_id: REQUEST }],
  }
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    platform.calls.push({ text, values })
    if (text.includes('council_module_state')) return Promise.resolve(platform.state)
    if (text.includes('council_karenz_list')) return Promise.resolve(platform.karenz)
    if (text.includes('submit_council_module_request')) return platform.submit()
    throw new Error(`unexpected platform query: ${text}`)
  }
  h.getCouncilDb.mockReturnValue(sql)
}

/**
 * A plt.council_karenz_list row. The real function returns no actor column; the double ADDS one on purpose
 * (a distinctive person), so a mapping that copied unknown columns would put it into the overview.
 */
const ACTOR_ID = 'ACTOR-ID-9f3c1e7a-0000-4000-8000-feedfacecafe'
const ACTOR_MAIL = 'schaltende.person.distinctive@example.org'
function karenzRow(module_key: string, state: string, over: Record<string, unknown> = {}) {
  return {
    karenz_id: KARENZ,
    module_key,
    state,
    switched_off_at: new Date('2026-11-05T09:00:00Z'),
    final_at: new Date('2026-12-05T09:00:00Z'),
    restore_requested_at: null,
    final_mode: null,
    platform_done_at: null,
    tenant_done_at: null,
    export_kept_until: null,
    actor_user_id: ACTOR_ID,
    actor_email: ACTOR_MAIL,
    ...over,
  }
}
const KARENZ = '55555555-5555-4555-8555-555555555555'
const submits = () => platform.calls.filter((c) => c.text.includes('submit_council_module_request'))

function config(modules: Record<string, boolean>) {
  h.readConfig.mockReturnValue({ modules })
}

beforeEach(() => {
  h.getCouncilDb.mockReset()
  h.insertSwitch.mockReset().mockResolvedValue(undefined)
  h.listSwitches.mockReset().mockResolvedValue([])
  h.readConfig.mockReset()
  h.writeAuditEntry.mockReset().mockResolvedValue(undefined)
  installPlatform()
  config({ calendar: true, elections: true, votes: false })
  _clearSwitchOffGuardsForTests()
})

describe('guards: who may switch, and with which assurance', () => {
  it('refuses a non-admin (Role.Member, Role.Vorstand) with 403 and queues nothing', async () => {
    for (const roles of [[Role.Member], [Role.Vorstand]]) {
      const r = await submitModuleSwitch(ctx(user({ roles })), { moduleId: 'votes', action: 'enable' }, deps())
      expect(r).toMatchObject({ ok: false, status: 403 })
    }
    expect(h.getCouncilDb).not.toHaveBeenCalled()
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('an it-admin may switch (the hierarchy includes council-admin)', async () => {
    const r = await submitModuleSwitch(ctx(user({ roles: [Role.ITAdmin] })), { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2' } }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
  })

  it('without a fresh loa2 it returns 401 STEP_UP_REQUIRED and queues nothing (stale authTime, loa 1)', async () => {
    const stale = await submitModuleSwitch(ctx(user({ authTime: nowSec - 3000 })), { moduleId: 'votes', action: 'enable' }, deps())
    expect(stale).toMatchObject({ ok: false, status: 401, code: 'STEP_UP_REQUIRED' })
    const low = await submitModuleSwitch(ctx(user({ loa: 1 })), { moduleId: 'votes', action: 'enable' }, deps())
    expect(low).toMatchObject({ ok: false, status: 401, code: 'STEP_UP_REQUIRED' })
    expect(h.getCouncilDb).not.toHaveBeenCalled()
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('a malformed input is a 400 before the platform is asked', async () => {
    for (const input of [null, {}, { moduleId: 5, action: 'enable' }, { moduleId: 'votes', action: 'drop' }, { moduleId: '', action: 'enable' }]) {
      const r = await submitModuleSwitch(ctx(), input as never, deps())
      expect(r).toMatchObject({ ok: false, status: 400 })
    }
    expect(h.getCouncilDb).not.toHaveBeenCalled()
  })
})

describe('switch-off is available since the 30-day Karenz exists (phase 2, Task 17)', () => {
  beforeEach(() => {
    installPlatform(CATALOGUE.map((k) => (k === 'votes' ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true }) : row(k))))
    config({ calendar: true, elections: true, votes: true })
  })

  it('the shipped constant is true', () => {
    expect(COUNCIL_DISABLE_ALLOWED).toBe(true)
  })

  it('DISABLE_NOT_YET is no longer returned: a council disable with the exact label queues disable_module', async () => {
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
    expect(submits()).toHaveLength(1)
    expect(submits()[0]!.values[0]).toBe('disable_module')
    expect(JSON.parse(submits()[0]!.values[2] as string)).toEqual({ slug: 'rat-a', module: 'votes' })
  })

  it('an injected disableAllowed false still refuses 422 DISABLE_NOT_YET before the platform is asked', async () => {
    h.getCouncilDb.mockClear()
    for (const confirm of [undefined, '', 'wrong', 'Abstimmungen']) {
      const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm }, deps({ disableAllowed: false }))
      expect(r).toMatchObject({ ok: false, status: 422, code: 'DISABLE_NOT_YET' })
    }
    expect(h.getCouncilDb).not.toHaveBeenCalled()
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('the default for deps.disableAllowed is the provisioning constant', async () => {
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }, { nowMs: () => NOW_MS, newKey: () => KEY })
    expect(r).toMatchObject({ ok: true })
  })
})

describe('Karenz states decide what a switch may do (Review Focus 1 and 2)', () => {
  const enabledVotes = () => CATALOGUE.map((k) => (k === 'votes' ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true }) : row(k)))
  const disabledVotes = (dpia: boolean) => CATALOGUE.map((k) => (k === 'votes' ? row(k, { state: 'disabled', has_row: true, dpia_recorded: dpia }) : row(k)))

  it('disable while the module is restoring returns 409 RESTORE_PENDING and queues nothing', async () => {
    installPlatform(enabledVotes(), [karenzRow('votes', 'restoring')])
    config({ votes: true })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }, deps())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'RESTORE_PENDING' })
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('RESTORE_PENDING is answered before the confirmation phrase is looked at', async () => {
    installPlatform(enabledVotes(), [karenzRow('votes', 'restoring')])
    config({ votes: true })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm: 'wrong' }, deps())
    expect(r).toMatchObject({ ok: false, code: 'RESTORE_PENDING' })
  })

  it('enable while finalizing returns 409 KARENZ_FINALIZING (never half restored) and queues nothing', async () => {
    installPlatform(disabledVotes(true), [karenzRow('votes', 'finalizing')])
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'KARENZ_FINALIZING' })
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('enable while the Karenz is open is the restore: the same enable_module request as a first enable, with no dpia input needed', async () => {
    // no recorded decision on the platform side, none in the body: a first enable would be DPIA_REQUIRED
    installPlatform(disabledVotes(false), [karenzRow('votes', 'open')])
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
    expect(submits()).toHaveLength(1)
    expect(submits()[0]!.values[0]).toBe('enable_module')
    expect(JSON.parse(submits()[0]!.values[2] as string)).toEqual({ slug: 'rat-a', module: 'votes' })
    expect(h.insertSwitch).toHaveBeenCalledWith(tenant.db, expect.objectContaining({ moduleId: 'votes', action: 'enable' }))
  })

  it('the DPIA rule is unchanged without an open Karenz (and a finalized or restored row is no Karenz)', async () => {
    for (const state of ['finalized', 'restored']) {
      installPlatform(disabledVotes(false), [karenzRow('votes', state)])
      const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
      expect(r, state).toMatchObject({ ok: false, status: 422, code: 'DPIA_REQUIRED' })
    }
    installPlatform(disabledVotes(false), [])
    expect(await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())).toMatchObject({ code: 'DPIA_REQUIRED' })
  })

  it('a Karenz of ANOTHER module changes nothing for this one', async () => {
    installPlatform(disabledVotes(true), [karenzRow('elections', 'finalizing'), karenzRow('calendar', 'restoring')])
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toMatchObject({ ok: true })
  })

  it('asks the platform for the Karenz rows of the tenant id', async () => {
    installPlatform(disabledVotes(true), [])
    await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    const call = platform.calls.find((c) => c.text.includes('council_karenz_list'))!
    expect(call.values[0]).toBe(CUSTOMER)
  })

  it('a Karenz list that cannot be read is 503 PLATFORM_ERROR and nothing is queued (fail closed)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    installPlatform(disabledVotes(true), [])
    const sql = h.getCouncilDb()
    h.getCouncilDb.mockReturnValue((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('council_karenz_list')) return Promise.reject(Object.assign(new Error('function plt.council_karenz_list does not exist'), { code: '42883' }))
      return sql(strings, ...values)
    })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toMatchObject({ ok: false, status: 503, code: 'PLATFORM_ERROR' })
    expect(submits()).toHaveLength(0)
    log.mockRestore()
  })
})

describe('the switch-off guard (Task 8 registry, Task 14 elections guard)', () => {
  beforeEach(() => {
    installPlatform(CATALOGUE.map((k) => (k === 'elections' ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true }) : row(k))))
    config({ calendar: true, elections: true, votes: false })
  })

  it('a registered guard reason returns 409 SWITCH_OFF_BLOCKED with the reason and queues nothing', async () => {
    registerSwitchOffGuard('elections', async () => 'Eine Wahl laeuft noch und kann nicht angehalten werden.')
    const r = await submitModuleSwitch(ctx(), { moduleId: 'elections', action: 'disable', confirm: 'Wahlen' }, deps())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'SWITCH_OFF_BLOCKED' })
    expect((r as { message: string }).message).toContain('Eine Wahl laeuft noch')
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })

  it('the calendar guard: a council admin who passes the phrase and the step-up still cannot switch off a leaf-backed calendar', async () => {
    registerSwitchOffGuard('calendar', calendarLeafSwitchOffGuard({ CALENDAR_BACKEND: 'service' }))
    const r = await submitModuleSwitch(ctx(), { moduleId: 'calendar', action: 'disable', confirm: 'Kalender' }, deps())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'SWITCH_OFF_BLOCKED' })
    expect((r as { message: string }).message).toBe(LEAF_BACKED_SWITCH_OFF_REASON)
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })

  it('the calendar guard lets an in-process calendar through', async () => {
    registerSwitchOffGuard('calendar', calendarLeafSwitchOffGuard({ CALENDAR_BACKEND: 'inprocess' }))
    const r = await submitModuleSwitch(ctx(), { moduleId: 'calendar', action: 'disable', confirm: 'Kalender' }, deps())
    expect(r).toMatchObject({ ok: true })
  })

  it('a guard that throws blocks too (fail closed), with the neutral reason', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerSwitchOffGuard('elections', async () => {
      throw new Error('helios unreachable at 10.0.0.9')
    })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'elections', action: 'disable', confirm: 'Wahlen' }, deps())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'SWITCH_OFF_BLOCKED' })
    expect((r as { message: string }).message).not.toContain('10.0.0.9')
    log.mockRestore()
  })

  it('a guard that finds nothing in the way lets the disable through', async () => {
    registerSwitchOffGuard('elections', async () => null)
    const r = await submitModuleSwitch(ctx(), { moduleId: 'elections', action: 'disable', confirm: 'Wahlen' }, deps())
    expect(r).toMatchObject({ ok: true })
  })

  it('the guard is asked for a disable only, never for an enable', async () => {
    const guard = vi.fn(async () => 'blocked')
    registerSwitchOffGuard('elections', guard)
    installPlatform(CATALOGUE.map((k) => (k === 'elections' ? row(k, { state: 'disabled', has_row: true, dpia_recorded: true }) : row(k))))
    await submitModuleSwitch(ctx(), { moduleId: 'elections', action: 'enable' }, deps())
    expect(guard).not.toHaveBeenCalled()
  })

  it('a wrong confirmation phrase is answered before the guard is asked (no network probe for a typo)', async () => {
    const guard = vi.fn(async () => 'blocked')
    registerSwitchOffGuard('elections', guard)
    const r = await submitModuleSwitch(ctx(), { moduleId: 'elections', action: 'disable', confirm: 'nope' }, deps())
    expect(r).toMatchObject({ code: 'CONFIRM_MISMATCH' })
    expect(guard).not.toHaveBeenCalled()
  })
})

describe('disable with the flag injected', () => {
  beforeEach(() => {
    installPlatform(CATALOGUE.map((k) => (k === 'votes' ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true }) : row(k))))
    config({ calendar: true, elections: true, votes: true })
  })
  const d = () => deps({ disableAllowed: true })

  it('a missing, wrong-case, padded or look-alike (Cyrillic) confirm phrase returns 422 CONFIRM_MISMATCH and queues nothing', async () => {
    for (const confirm of [undefined, '', 'abstimmungen', ' Abstimmungen', 'Abstimmungen ', 'Abstimmungеn' /* Cyrillic e */, 'Wahlen']) {
      const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm }, d())
      expect(r, JSON.stringify(confirm)).toMatchObject({ ok: false, status: 422, code: 'CONFIRM_MISMATCH' })
    }
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('the exact label queues one request (the NFC-equivalence of decomposed input is pinned on confirmationMatches in catalogue-map.test.ts; no switchable label has an umlaut)', async () => {
    const exact = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }, d())
    expect(exact).toEqual({ ok: true, requestId: REQUEST })
    expect(submits()).toHaveLength(1)
    expect(submits()[0]!.values[0]).toBe('disable_module')
    expect(JSON.parse(submits()[0]!.values[2] as string)).toEqual({ slug: 'rat-a', module: 'votes' })
    expect(h.insertSwitch).toHaveBeenCalledWith(tenant.db, expect.objectContaining({ requestId: REQUEST, moduleId: 'votes', action: 'disable', actorUserId: PERSON }))
  })

  it('returns 409 NOOP only when the platform is not enabled AND config.modules is false', async () => {
    installPlatform(CATALOGUE.map((k) => row(k)))
    config({ calendar: true, elections: true, votes: false })
    const noop = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }, d())
    expect(noop).toMatchObject({ ok: false, status: 409, code: 'NOOP' })
    // config still says on although the platform says off: the request is queued so the reconciler writes the truth
    config({ calendar: true, elections: true, votes: true })
    const queued = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'disable', confirm: 'Abstimmungen' }, d())
    expect(queued).toMatchObject({ ok: true })
  })
})

describe('enable: refusals before anything is queued (Review Focus 7)', () => {
  it('vault is 422 MODULE_DENIED with the DENY reason, and the deny list is exactly vault (board was lifted)', async () => {
    expect(Object.keys(MODULE_DENY)).toEqual(['vault'])
    for (const id of ['vault']) {
      const r = await submitModuleSwitch(ctx(), { moduleId: id, action: 'enable' }, deps())
      expect(r).toMatchObject({ ok: false, status: 422, code: 'MODULE_DENIED' })
      expect((r as { message: string }).message).toContain(MODULE_DENY[id]!)
    }
    expect(submits()).toHaveLength(0)
  })

  it('elections is held off: an enable is 422 MODULE_HELD_OFF and nothing is queued (the pin would make it a silent no-op)', async () => {
    installPlatform(CATALOGUE.map((k) => (k === 'elections' ? row(k, { state: 'disabled', has_row: true, dpia_recorded: true }) : row(k))))
    config({ calendar: true, elections: false, votes: false })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'elections', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2' } }, deps())
    expect(r).toMatchObject({ ok: false, status: 422, code: 'MODULE_HELD_OFF' })
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('a module listed in modules/disabled.json is 422 MODULE_NOT_SHIPPED', async () => {
    const r = await submitModuleSwitch(ctx(), { moduleId: 'finance', action: 'enable' }, deps({ disabledIds: ['content', 'finance', 'vault'] }))
    expect(r).toMatchObject({ ok: false, status: 422, code: 'MODULE_NOT_SHIPPED' })
    expect(submits()).toHaveLength(0)
  })

  it('board, files, messaging, publishing, handover and an unknown id are 422 MODULE_NOT_SWITCHABLE (a council still cannot switch board)', async () => {
    for (const id of ['board', 'files', 'messaging', 'publishing', 'handover', 'nope']) {
      for (const action of ['enable', 'disable'] as const) {
        const r = await submitModuleSwitch(ctx(), { moduleId: id, action }, deps())
        expect(r, `${id} ${action}`).toMatchObject({ ok: false, status: 422, code: 'MODULE_NOT_SWITCHABLE' })
      }
    }
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('a switchable id the platform catalogue does not carry is 422 MODULE_NOT_SHIPPED', async () => {
    installPlatform(CATALOGUE.filter((k) => k !== 'calendar').map((k) => row(k)))
    const r = await submitModuleSwitch(ctx(), { moduleId: 'calendar', action: 'enable' }, deps())
    expect(r).toMatchObject({ ok: false, status: 422, code: 'MODULE_NOT_SHIPPED' })
  })

  it('the deny mirror equals the provisioning DENY_REASONS keys and text (pin)', () => {
    expect(MODULE_DENY).toEqual(DENY_REASONS)
  })
})

describe('enable: DPIA decision', () => {
  it('without a recorded DPIA decision and without dpia in the body returns 422 DPIA_REQUIRED', async () => {
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toMatchObject({ ok: false, status: 422, code: 'DPIA_REQUIRED' })
    expect(submits()).toHaveLength(0)
  })

  it('with {requiresDpia:false, documentRef:"TOM 4.2"} it queues args {slug, module, dpia} carrying the council reason', async () => {
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef: 'TOM 4.2' } }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
    expect(JSON.parse(submits()[0]!.values[2] as string)).toEqual({
      slug: 'rat-a',
      module: 'votes',
      dpia: { requires_dpia: false, reason_codes: ['council_decision'], document_ref: 'TOM 4.2' },
    })
  })

  it('with a recorded decision the body needs no dpia and the args carry none', async () => {
    installPlatform(CATALOGUE.map((k) => (k === 'votes' ? row(k, { dpia_recorded: true }) : row(k))))
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
    expect(JSON.parse(submits()[0]!.values[2] as string)).toEqual({ slug: 'rat-a', module: 'votes' })
  })

  it('a documentRef that is blank, over 500 chars, has control characters or starts with "-" is 422 DPIA_INVALID', async () => {
    const bad = ['', '   ', 'x'.repeat(501), 'TOM\n4.2', 'TOM\u0000', '-rf', '  -x', 'a‮b']
    for (const documentRef of bad) {
      const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: false, documentRef } }, deps())
      expect(r, JSON.stringify(documentRef)).toMatchObject({ ok: false, status: 422, code: 'DPIA_INVALID' })
    }
    const notBool = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia: { requiresDpia: 'no' as never, documentRef: 'TOM 4.2' } }, deps())
    expect(notBool).toMatchObject({ ok: false, status: 422, code: 'DPIA_INVALID' })
    expect(submits()).toHaveLength(0)
  })
})

describe('enable: no-op check uses BOTH the platform state and config.modules', () => {
  const dpia = { requiresDpia: false, documentRef: 'TOM 4.2' }

  it('409 NOOP only when the platform state is enabled AND config.modules[manifest] is true', async () => {
    installPlatform(CATALOGUE.map((k) => (k === 'votes' ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true }) : row(k))))
    config({ votes: true })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'NOOP' })
    expect(submits()).toHaveLength(0)
  })

  it('platform enabled but config false: the request is queued (the reconciler writes the platform truth)', async () => {
    installPlatform(CATALOGUE.map((k) => (k === 'votes' ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true }) : row(k))))
    config({ votes: false })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable' }, deps())
    expect(r).toMatchObject({ ok: true })
  })

  it('an unmanaged module (no platform row, default-on in config) is queued, not refused', async () => {
    config({ calendar: true })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'calendar', action: 'enable', dpia }, deps())
    expect(r).toMatchObject({ ok: true })
  })
})

describe('the platform submit', () => {
  const dpia = { requiresDpia: false, documentRef: 'TOM 4.2' }

  it("passes p_acr loa2, p_auth_time from the ID token's own auth_time, the encodeEvidence token and p_person_id = user.id", async () => {
    await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    const [kind, slug, args, key, person, acr, authTime, token] = submits()[0]!.values
    expect(kind).toBe('enable_module')
    expect(slug).toBe('rat-a')
    expect(typeof args).toBe('string')
    expect(key).toBe(KEY)
    expect(person).toBe(PERSON)
    expect(acr).toBe('loa2')
    // the executor compares the recorded time with the ID token's auth_time (iat when absent), not with the
    // session's server-clock step-up stamp (user.authTime), so the token's own value is what is recorded
    expect(new Date(authTime as string).getTime()).toBe(ID_AUTH_TIME * 1000)
    expect(new Date(authTime as string).getTime()).not.toBe(user().authTime * 1000)
    expect(token).toBe(JSON.stringify({ id: ID_TOKEN, access: ACCESS_TOKEN }))
  })

  it('an ID token without auth_time records its iat', async () => {
    const iat = nowSec - 23
    await submitModuleSwitch(ctx(user(), jwt({ iat, sid: 's-1' })), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(new Date(submits()[0]!.values[6] as string).getTime()).toBe(iat * 1000)
  })

  it('an ID token with neither auth_time nor iat, a non-token, or a sign-in beyond the 3600 s evidence window asks for a new step-up and queues nothing', async () => {
    for (const idToken of [jwt({ sid: 's-1' }), 'not-a-jwt', jwt({ iat: nowSec - 3601 })]) {
      const r = await submitModuleSwitch(ctx(user(), idToken), { moduleId: 'votes', action: 'enable', dpia }, deps())
      expect(r).toMatchObject({ ok: false, status: 401, code: 'STEP_UP_REQUIRED' })
    }
    expect(submits()).toHaveLength(0)
    expect(h.insertSwitch).not.toHaveBeenCalled()
  })

  it('reads the state for the tenant id (the platform customer id)', async () => {
    await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    const state = platform.calls.find((c) => c.text.includes('council_module_state'))!
    expect(state.values).toEqual([CUSTOMER])
  })

  it('a queued/running request for the slug makes the submit return 409 IN_FLIGHT (SQLSTATE 55006)', async () => {
    platform.submit = async () => {
      throw Object.assign(new Error('another request for this customer is queued or running'), { code: '55006' })
    }
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(r).toMatchObject({ ok: false, status: 409, code: 'IN_FLIGHT' })
    expect((r as { message: string }).message).toMatch(/läuft bereits/)
    expect(h.insertSwitch).not.toHaveBeenCalled()
    expect(h.writeAuditEntry).not.toHaveBeenCalled()
  })

  it('a sign-in the platform finds too old (28000) asks for a new step-up', async () => {
    platform.submit = async () => {
      throw Object.assign(new Error('the sign-in time is outside the last hour'), { code: '28000' })
    }
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(r).toMatchObject({ ok: false, status: 401, code: 'STEP_UP_REQUIRED' })
  })

  it('bad input (22023) is 422, any other platform failure is 503 PLATFORM_ERROR with the detail logged, not shown', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    platform.submit = async () => {
      throw Object.assign(new Error('invalid customer slug'), { code: '22023' })
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())).toMatchObject({ ok: false, status: 422, code: 'INVALID' })
    // a 22023 means the UI-side checks and the platform have drifted: the platform's reason is logged
    expect(warn.mock.calls.flat().join(' ')).toContain('invalid customer slug')
    warn.mockRestore()
    platform.submit = async () => {
      throw Object.assign(new Error('connection to postgres-blue at 10.0.0.5 refused'), { code: 'ECONNREFUSED' })
    }
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(r).toMatchObject({ ok: false, status: 503, code: 'PLATFORM_ERROR' })
    expect((r as { message: string }).message).not.toMatch(/10\.0\.0\.5|postgres-blue/)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('CouncilNotConfigured returns 503 NOT_CONFIGURED, never an empty result', async () => {
    h.getCouncilDb.mockImplementation(() => {
      throw new CouncilNotConfigured()
    })
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(r).toMatchObject({ ok: false, status: 503, code: 'NOT_CONFIGURED' })
    expect((r as { message: string }).message).toMatch(/nicht konfiguriert/)
  })
})

describe('after the platform accepted', () => {
  const dpia = { requiresDpia: false, documentRef: 'TOM 4.2' }

  it('records the tenant-side switch and writes the audit entry module.switch.requested naming module, action and request id', async () => {
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
    expect(h.insertSwitch).toHaveBeenCalledWith(tenant.db, { requestId: REQUEST, moduleId: 'votes', action: 'enable', actorUserId: PERSON })
    expect(h.writeAuditEntry).toHaveBeenCalledTimes(1)
    const entry = h.writeAuditEntry.mock.calls[0]![0]
    expect(entry.userId).toBe(PERSON)
    expect(entry.field).toBe('module.switch.requested')
    expect(entry.newValue).toContain('module=votes')
    expect(entry.newValue).toContain('action=enable')
    expect(entry.newValue).toContain(`request=${REQUEST}`)
    // the evidence token never reaches the audit chain
    expect(JSON.stringify(entry)).not.toContain(ACCESS_TOKEN)
  })

  it('if the audit write fails the request is still queued and the failure is logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.writeAuditEntry.mockRejectedValue(new Error('audit down'))
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('if the tenant-side insert fails after the platform accepted: success with the id, logged loudly (the reconciler adopts the row)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.insertSwitch.mockRejectedValue(new Error('tenant db down'))
    const r = await submitModuleSwitch(ctx(), { moduleId: 'votes', action: 'enable', dpia }, deps())
    expect(r).toEqual({ ok: true, requestId: REQUEST })
    expect(log).toHaveBeenCalled()
    expect(String(log.mock.calls[0]![0])).toContain(REQUEST)
    log.mockRestore()
  })
})

describe('loadModuleOverview', () => {
  it('lists only calendar and votes (elections is held off and invisible), reports enabled from the platform when has_row is true and from config.modules when it is not, and disableAvailable true', async () => {
    installPlatform(
      CATALOGUE.map((k) =>
        k === 'votes'
          ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true })
          : k === 'elections'
            ? row(k, { state: 'disabled', has_row: true })
            : row(k),
      ),
    )
    config({ calendar: true, elections: true, votes: false })
    const o = await loadModuleOverview(tenant)
    expect(o.modules.map((m) => m.moduleId)).toEqual(['calendar', 'votes'])
    const by = Object.fromEntries(o.modules.map((m) => [m.moduleId, m]))
    expect(by.votes).toMatchObject({ enabled: true, managed: true, dpiaRecorded: true, label: 'Abstimmungen' })
    // no platform row: follows config.modules
    expect(by.calendar).toMatchObject({ enabled: true, managed: false, label: 'Kalender' })
    expect(o.disableAvailable).toBe(true)
    expect(o.problem).toBeNull()
    // no Karenz row: no Karenz view
    expect(o.modules.every((m) => m.karenz === null)).toBe(true)
  })

  it('an unmanaged module whose config.modules is absent reads as on (the default of every toggleable manifest)', async () => {
    config({})
    const o = await loadModuleOverview(tenant)
    expect(o.modules.find((m) => m.moduleId === 'calendar')).toMatchObject({ enabled: true, managed: false })
  })

  it('lists the pending requests of a module and its latest failure text', async () => {
    h.listSwitches.mockResolvedValue([
      { requestId: 'r3', moduleId: 'votes', action: 'enable', actorUserId: PERSON, submittedAt: new Date('2026-10-31T09:00:00Z'), state: 'queued', outcome: null, configError: null },
      { requestId: 'r2', moduleId: 'calendar', action: 'enable', actorUserId: PERSON, submittedAt: new Date('2026-10-31T08:00:00Z'), state: 'failed', outcome: 'DPIA gate refused: NO_DPIA_DECISION', configError: null },
    ])
    const o = await loadModuleOverview(tenant)
    const by = Object.fromEntries(o.modules.map((m) => [m.moduleId, m]))
    expect(by.votes!.pending).toEqual([{ requestId: 'r3', action: 'enable', state: 'queued' }])
    expect(by.votes!.lastFailure).toBeNull()
    expect(by.calendar!.pending).toEqual([])
    expect(by.calendar!.lastFailure).toBe('DPIA gate refused: NO_DPIA_DECISION')
  })

  it('plt succeeded but config could not be written: the request is still applying and the error is visible (Review Focus 4)', async () => {
    h.listSwitches.mockResolvedValue([
      { requestId: 'r1', moduleId: 'calendar', action: 'enable', actorUserId: PERSON, submittedAt: new Date('2026-10-31T07:00:00Z'), state: 'applying', outcome: null, configError: 'config.json not writable' },
    ])
    const o = await loadModuleOverview(tenant)
    const calendar = o.modules.find((m) => m.moduleId === 'calendar')!
    expect(calendar.pending).toEqual([{ requestId: 'r1', action: 'enable', state: 'applying' }])
    expect(calendar.lastFailure).toBe('config.json not writable')
  })

  it('a held-off module (elections) is not offered, even when the platform has a row for it that reads enabled', async () => {
    installPlatform(CATALOGUE.map((k) => (k === 'elections' ? row(k, { state: 'enabled', has_row: true, dpia_recorded: true }) : row(k))))
    config({ calendar: true, elections: false, votes: true })
    const o = await loadModuleOverview(tenant)
    expect(o.modules.map((m) => m.moduleId)).not.toContain('elections')
    expect(JSON.stringify(o)).not.toContain('Wahlen')
  })

  it('a later success clears an older failure', async () => {
    h.listSwitches.mockResolvedValue([
      { requestId: 'r2', moduleId: 'calendar', action: 'enable', actorUserId: PERSON, submittedAt: new Date('2026-10-31T09:00:00Z'), state: 'applied', outcome: 'ok', configError: null },
      { requestId: 'r1', moduleId: 'calendar', action: 'enable', actorUserId: PERSON, submittedAt: new Date('2026-10-31T08:00:00Z'), state: 'failed', outcome: 'old failure', configError: null },
    ])
    const o = await loadModuleOverview(tenant)
    expect(o.modules.find((m) => m.moduleId === 'calendar')!.lastFailure).toBeNull()
  })

  it('CouncilNotConfigured throws, never an empty overview', async () => {
    h.getCouncilDb.mockImplementation(() => {
      throw new CouncilNotConfigured()
    })
    await expect(loadModuleOverview(tenant)).rejects.toBeInstanceOf(CouncilNotConfigured)
  })

  it('a tenant-side history that cannot be read degrades to problem text, not to a lie about the state', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.listSwitches.mockRejectedValue(new Error('tenant db down'))
    const o = await loadModuleOverview(tenant)
    expect(o.problem).toMatch(/Verlauf/)
    expect(o.modules).toHaveLength(2)
    log.mockRestore()
  })
})

describe('loadModuleOverview: the Karenz view of a module that is off', () => {
  const NOTICE_DONE = { karenzId: KARENZ, step: 'notice:switchoff', state: 'done', attempts: 1, lastError: null, lastReportedAt: null, doneAt: new Date(), updatedAt: new Date() }
  const karenzDeps = (over: Partial<KarenzViewDeps> = {}): { karenz: Partial<KarenzViewDeps> } => ({
    karenz: {
      listSteps: async () => [NOTICE_DONE] as never,
      listItems: async () => [],
      noticeCounts: async () => ({ sent: 2, failed: 0 }),
      listRetained: async () => [],
      skippedHolders: async () => 1,
      now: () => new Date('2026-11-10T12:00:00Z'),
      ...over,
    },
  })
  const offVotes = () => CATALOGUE.map((k) => (k === 'votes' ? row(k, { state: 'disabled', has_row: true, dpia_recorded: true }) : row(k)))

  it("an open Karenz row becomes the module's karenz view; the other modules have none", async () => {
    installPlatform(offVotes(), [karenzRow('votes', 'open')])
    const o = await loadModuleOverview(tenant, karenzDeps())
    const by = Object.fromEntries(o.modules.map((m) => [m.moduleId, m]))
    expect(by.votes!.karenz).toMatchObject({ karenzId: KARENZ, state: 'open', canRestore: true, daysLeft: 25, mail: { recipients: 2, failed: 0, skippedHolders: 1 } })
    expect(by.calendar!.karenz).toBeNull()
  })

  it('restoring and finalizing rows are shown too; restored and finalized rows are not (the module is back, or it is gone)', async () => {
    for (const [state, shown] of [['open', true], ['restoring', true], ['finalizing', true], ['restored', false], ['finalized', false]] as const) {
      installPlatform(offVotes(), [karenzRow('votes', state)])
      const o = await loadModuleOverview(tenant, karenzDeps())
      expect(o.modules.find((m) => m.moduleId === 'votes')!.karenz !== null, state).toBe(shown)
    }
  })

  it("ModuleOverview JSON never contains the platform row's actor id or the actor's e-mail (the response is actor-free)", async () => {
    installPlatform(offVotes(), [karenzRow('votes', 'open')])
    // the tenant-side switch history DOES carry the actor (module_switch_request.actor_user_id): it must not travel either
    h.listSwitches.mockResolvedValue([
      { requestId: 'r1', moduleId: 'votes', action: 'disable', actorUserId: ACTOR_ID, submittedAt: new Date('2026-11-05T09:00:00Z'), state: 'applied', outcome: 'ok', configError: null },
    ])
    const o = await loadModuleOverview(tenant, karenzDeps())
    const json = JSON.stringify(o)
    expect(json).not.toContain(ACTOR_ID)
    expect(json).not.toContain(ACTOR_MAIL)
    expect(json).not.toContain('actor')
    expect(json).not.toContain(PERSON)
  })

  it('a Karenz list the platform cannot answer degrades to a problem text; the modules are still listed, without a karenz view', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    installPlatform(offVotes(), [])
    const sql = h.getCouncilDb()
    h.getCouncilDb.mockReturnValue((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('council_karenz_list')) return Promise.reject(new Error('platform down'))
      return sql(strings, ...values)
    })
    const o = await loadModuleOverview(tenant, karenzDeps())
    expect(o.modules).toHaveLength(2)
    expect(o.modules.every((m) => m.karenz === null)).toBe(true)
    expect(o.problem).toMatch(/30-Tage-Frist/)
    expect(JSON.stringify(o)).not.toContain('platform down')
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('the Karenz problem does not hide a history problem', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.listSwitches.mockRejectedValue(new Error('tenant db down'))
    installPlatform(offVotes(), [karenzRow('votes', 'open')])
    const o = await loadModuleOverview(tenant, karenzDeps())
    expect(o.problem).toMatch(/Verlauf/)
    expect(o.modules.find((m) => m.moduleId === 'votes')!.karenz).not.toBeNull()
    log.mockRestore()
  })
})
