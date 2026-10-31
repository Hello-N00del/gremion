// Module switch-off with the 30-day Karenz (phase 2), Task 2 on the scratch
// PostgreSQL 18 (run.mjs): migration 0015 of gremion_platform.
//  - plt.module_database gains the state `blocked` (module database kept alive but
//    unreachable) and may reach it only with a recorded export;
//  - plt.module_karenz is the authoritative 30-day clock, one live row per
//    (customer, module); plt.module_karenz_event is its append-only report log;
//  - plt.council_karenz_list / plt.council_karenz_report are the only two doors of
//    the shared council role gremion_ui_modules: no actor column, no export path,
//    advisory reports only.
// The council LOGIN role is made here by hand (marker membership + EXECUTE on the
// two functions): ensureCouncilRequester belongs to phase 1.
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failure, open, setupRoles, type Roles } from './scratch.ts'

const MARKER = 'plt_council_requester'
const LIST = 'plt.council_karenz_list(uuid, integer)'
const REPORT = 'plt.council_karenz_report(uuid, uuid, text, text, text, text)'

let r: Roles
/** A superuser pool ON gremion_platform: fixtures and the documented trigger/CHECK bypass checks. */
let pa: ReturnType<typeof open>
/** A pool AS the hand-made council role. */
let council: ReturnType<typeof open>
const councilRole = 't043d_karenz_ui'
const councilPassword = randomBytes(24).toString('base64url')
let modules: { module_id: string; module_key: string }[] = []

beforeAll(async () => {
  r = await setupRoles('karenz')
  pa = open('gremion_platform', 2)
  await r.admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MARKER}') THEN CREATE ROLE ${MARKER} NOLOGIN; END IF; END $$`)
  await r.admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${councilRole}') THEN CREATE ROLE ${councilRole} LOGIN NOINHERIT PASSWORD '${councilPassword}'; END IF; END $$`)
  await r.admin.unsafe(`ALTER ROLE ${councilRole} PASSWORD '${councilPassword}'`)
  await r.admin.unsafe(`GRANT ${MARKER} TO ${councilRole} WITH INHERIT FALSE, SET FALSE`)
  await r.admin.unsafe(`GRANT CONNECT ON DATABASE gremion_platform TO ${councilRole}`)
  await pa.unsafe(`GRANT USAGE ON SCHEMA plt TO ${councilRole}`)
  for (const f of [LIST, REPORT]) await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${f} TO ${councilRole}`)
  council = open('gremion_platform', 2, councilRole, councilPassword)
  modules = await pa<{ module_id: string; module_key: string }[]>`SELECT module_id::text, module_key FROM plt.module ORDER BY module_key LIMIT 6`
  if (modules.length < 3) throw new Error('the catalogue seeded fewer than 3 modules')
})
afterAll(async () => {
  await council?.end({ timeout: 5 })
  await pa?.end({ timeout: 5 })
  await r?.close()
})

interface KarenzSeed {
  customer: string
  module: string
  state: string
  switchedOff: string
  finalAt: string
  restoreRequested: string | null
  restoredAt: string | null
  platformDone: string | null
  tenantDone: string | null
  finalMode: string | null
}
/** SQL interval strings relative to now(), e.g. '-31 days'. */
function seed(over: Partial<KarenzSeed> = {}): KarenzSeed {
  return {
    customer: randomUUID(),
    module: modules[0]!.module_id,
    state: 'open',
    switchedOff: '-1 hour',
    finalAt: '29 days 23 hours',
    restoreRequested: null,
    restoredAt: null,
    platformDone: null,
    tenantDone: null,
    finalMode: null,
    ...over,
  }
}
const ts = (i: string | null) => (i === null ? null : `now() + interval '${i}'`)
async function insertKarenz(s: KarenzSeed): Promise<string> {
  const rows = await pa.unsafe<{ id: string }[]>(
    `INSERT INTO plt.module_karenz (customer_id, module_id, state, switched_off_at, final_at, restore_requested_at, restored_at,
                                    platform_done_at, tenant_done_at, final_mode, actor_kind, actor_id)
     VALUES ('${s.customer}', '${s.module}', '${s.state}', ${ts(s.switchedOff)}, ${ts(s.finalAt)}, ${ts(s.restoreRequested) ?? 'NULL'},
             ${ts(s.restoredAt) ?? 'NULL'}, ${ts(s.platformDone) ?? 'NULL'}, ${ts(s.tenantDone) ?? 'NULL'},
             ${s.finalMode === null ? 'NULL' : `'${s.finalMode}'`}, 'person', '${randomUUID()}')
     RETURNING karenz_id::text AS id`,
  )
  return rows[0]!.id
}
/** A row whose final_at is already in the past (the day-30 moment has come). */
const dueSeed = (over: Partial<KarenzSeed> = {}) => seed({ switchedOff: '-31 days', finalAt: '-1 day', ...over })

const dbName = () => `t_${randomUUID().replaceAll('-', '')}__votes`
async function insertModuleDatabase(state: string, withExport: boolean): Promise<void> {
  const exp = withExport ? `'/exports/x/votes/x.dump', '${'a'.repeat(64)}', 100, now()` : 'NULL, NULL, NULL, NULL'
  await pa.unsafe(
    `INSERT INTO plt.module_database (customer_id, module_id, db_name, state, export_path, export_sha256, export_bytes, exported_at)
     VALUES ('${randomUUID()}', '${modules[0]!.module_id}', '${dbName()}', '${state}', ${exp})`,
  )
}

const list = (sql: ReturnType<typeof open>, customer: string | null, days: number | null) =>
  sql<Record<string, unknown>[]>`SELECT * FROM plt.council_karenz_list(${customer}::uuid, ${days}::integer)`
const report = (
  sql: ReturnType<typeof open>,
  customer: string,
  karenz: string,
  step: string,
  level: string,
  message: string,
  mark: string | null = null,
) => sql`SELECT plt.council_karenz_report(${customer}::uuid, ${karenz}::uuid, ${step}, ${level}, ${message}, ${mark})`
const row = async (id: string) =>
  (
    await pa<Record<string, unknown>[]>`
      SELECT state, restored_at IS NOT NULL AS has_restored_at, tenant_done_at IS NOT NULL AS has_tenant_done, platform_done_at IS NOT NULL AS has_platform_done
        FROM plt.module_karenz WHERE karenz_id = ${id}::uuid`
  )[0]!

describe('plt.module_database state blocked', () => {
  it('blocked without a recorded export violates module_database_blocked_export_check (23514)', async () => {
    const f = await failure(insertModuleDatabase('blocked', false))
    expect(f?.code).toBe('23514')
    expect(f?.message).toContain('module_database_blocked_export_check')
  })

  it('blocked with a recorded export is accepted, and enabling, enabled, disabling and dropped keep working', async () => {
    await insertModuleDatabase('blocked', true)
    await insertModuleDatabase('enabling', false)
    await insertModuleDatabase('enabled', false)
    await insertModuleDatabase('disabling', true)
    await expect(failure(pa.unsafe(`INSERT INTO plt.module_database (customer_id, module_id, db_name, state, export_path, export_sha256, export_bytes, exported_at, dropped_at)
      VALUES ('${randomUUID()}', '${modules[0]!.module_id}', '${dbName()}', 'dropped', '/e/x.dump', '${'b'.repeat(64)}', 5, now(), now())`))).resolves.toBeNull()
  })

  it('an unknown state still violates module_database_state_check', async () => {
    const f = await failure(insertModuleDatabase('paused', false))
    expect(f?.code).toBe('23514')
    expect(f?.message).toContain('module_database_state_check')
  })
})

describe('plt.module_karenz', () => {
  it('allows one live row per (customer, module) and any number of closed ones', async () => {
    const s = seed()
    await insertKarenz(s)
    for (const state of ['open', 'restoring', 'finalizing']) {
      const f = await failure(insertKarenz({ ...s, state, restoreRequested: state === 'restoring' ? '-1 hour' : null }))
      expect(f?.code, state).toBe('23505')
    }
    // the same customer with ANOTHER module, and any number of closed rows for the pair
    await expect(failure(insertKarenz({ ...s, module: modules[1]!.module_id }))).resolves.toBeNull()
    for (const [state, extra] of [
      ['restored', { restoreRequested: '-2 days', restoredAt: '-1 day' }],
      ['restored', { restoreRequested: '-3 days', restoredAt: '-2 days' }],
      ['finalized', { platformDone: '-1 day', tenantDone: '-1 day' }],
    ] as const) {
      await expect(failure(insertKarenz({ ...s, state, switchedOff: '-40 days', finalAt: '-10 days', ...extra }))).resolves.toBeNull()
    }
  })

  it('final_at must be later than switched_off_at', async () => {
    const f = await failure(insertKarenz(seed({ switchedOff: '0 seconds', finalAt: '0 seconds' })))
    expect(f?.code).toBe('23514')
    expect(f?.message).toContain('module_karenz_final_after_off_check')
    expect((await failure(insertKarenz(seed({ switchedOff: '1 hour', finalAt: '-1 hour' }))))?.code).toBe('23514')
  })

  it('state, actor_kind and final_mode accept their listed values and nothing else', async () => {
    expect((await failure(insertKarenz(seed({ state: 'paused' }))))?.message).toContain('module_karenz_state_check')
    for (const mode of ['dry', 'live']) await expect(failure(insertKarenz(seed({ finalMode: mode })))).resolves.toBeNull()
    expect((await failure(insertKarenz(seed({ finalMode: 'maybe' }))))?.message).toContain('module_karenz_final_mode_check')
    expect((await failure(insertKarenz(seed({ finalMode: 'DRY' }))))?.message).toContain('module_karenz_final_mode_check')
    const f = await failure(
      pa.unsafe(`INSERT INTO plt.module_karenz (customer_id, module_id, final_at, actor_kind) VALUES ('${randomUUID()}', '${modules[0]!.module_id}', now() + interval '1 day', 'robot')`),
    )
    expect(f?.message).toContain('module_karenz_actor_kind_check')
  })

  it('a row cannot claim restoring, restored or finalized without the column that proves it (module_karenz_state_columns_check)', async () => {
    for (const over of [
      { state: 'restoring' },
      { state: 'restored', restoreRequested: '-2 hours' },
      { state: 'restored', restoredAt: '-1 hour' },
      { state: 'finalized', platformDone: '-1 hour' },
      { state: 'finalized', tenantDone: '-1 hour' },
    ] as const) {
      const f = await failure(insertKarenz(seed({ switchedOff: '-31 days', finalAt: '-1 day', ...over })))
      expect(f?.message, JSON.stringify(over)).toContain('module_karenz_state_columns_check')
    }
  })

  it('export_path and export_sha256 are both set or both null, and the sha is 64 lowercase hex characters', async () => {
    const id = await insertKarenz(seed())
    const upd = (set: string) => pa.unsafe(`UPDATE plt.module_karenz SET ${set} WHERE karenz_id = '${id}'`)
    expect((await failure(upd(`export_path = '/e/x.dump'`)))?.message).toContain('module_karenz_export_pair_check')
    expect((await failure(upd(`export_path = '/e/x.dump', export_sha256 = '${'A'.repeat(64)}'`)))?.message).toContain('module_karenz_export_sha256_check')
    expect(await failure(upd(`export_path = '/e/x.dump', export_sha256 = '${'a'.repeat(64)}'`))).toBeNull()
  })

  it('a module row that does not exist is refused by the foreign key', async () => {
    expect((await failure(insertKarenz(seed({ module: randomUUID() }))))?.code).toBe('23503')
  })

  it('the update trigger keeps customer_id and created_at immutable and bumps row_version', async () => {
    const s = seed()
    const id = await insertKarenz(s)
    expect((await failure(pa.unsafe(`UPDATE plt.module_karenz SET customer_id = '${randomUUID()}' WHERE karenz_id = '${id}'`)))?.code).toBe('23514')
    await pa.unsafe(`UPDATE plt.module_karenz SET final_mode = 'dry' WHERE karenz_id = '${id}'`)
    const [v] = await pa<{ row_version: string }[]>`SELECT row_version::text FROM plt.module_karenz WHERE karenz_id = ${id}::uuid`
    expect(v!.row_version).toBe('2')
  })
})

describe('plt.module_karenz_event', () => {
  it('cannot be updated, deleted or truncated, not even by a superuser', async () => {
    const id = await insertKarenz(seed())
    await pa.unsafe(`INSERT INTO plt.module_karenz_event (karenz_id, level, step, message) VALUES ('${id}', 'info', 'notice:switchoff', 'sent 3')`)
    expect((await failure(pa.unsafe(`UPDATE plt.module_karenz_event SET message = 'x' WHERE karenz_id = '${id}'`)))?.code).toBe('23514')
    expect((await failure(pa.unsafe(`DELETE FROM plt.module_karenz_event WHERE karenz_id = '${id}'`)))?.code).toBe('23514')
    expect((await failure(pa.unsafe(`TRUNCATE plt.module_karenz_event`)))?.code).toBe('23514')
    expect((await pa`SELECT 1 FROM plt.module_karenz_event WHERE karenz_id = ${id}::uuid`).length).toBe(1)
  })

  it('checks level, step shape and message length at the table as well', async () => {
    const id = await insertKarenz(seed())
    const ins = (level: string, step: string, message: string) =>
      pa.unsafe(`INSERT INTO plt.module_karenz_event (karenz_id, level, step, message) VALUES ('${id}', '${level}', '${step}', '${message}')`)
    expect((await failure(ins('warn', 'x', 'm')))?.message).toContain('module_karenz_event_level_check')
    expect((await failure(ins('info', 'has space', 'm')))?.message).toContain('module_karenz_event_step_check')
    expect((await failure(ins('info', 'Upper', 'm')))?.message).toContain('module_karenz_event_step_check')
    expect((await failure(ins('info', 'a'.repeat(61), 'm')))?.message).toContain('module_karenz_event_step_check')
    expect((await failure(ins('info', 'a'.repeat(60), 'm')))).toBeNull()
    expect((await failure(ins('info', 'ok:step_1-2', 'x'.repeat(1001))))?.message).toContain('module_karenz_event_message_check')
    expect((await failure(ins('error', 'ok:step_1-2', 'x'.repeat(1000))))).toBeNull()
  })
})

describe('plt.council_karenz_list', () => {
  it("returns only the asked customer's rows, live ones and closed ones inside the window", async () => {
    const customer = randomUUID()
    const live = await insertKarenz(seed({ customer, module: modules[0]!.module_id }))
    const restoring = await insertKarenz(seed({ customer, module: modules[1]!.module_id, state: 'restoring', restoreRequested: '-1 hour' }))
    const finalizing = await insertKarenz(dueSeed({ customer, module: modules[2]!.module_id, state: 'finalizing', finalMode: 'live' }))
    const restoredRecent = await insertKarenz(seed({ customer, module: modules[0]!.module_id, state: 'restored', switchedOff: '-20 days', finalAt: '10 days', restoreRequested: '-3 days', restoredAt: '-2 days' }))
    const finalizedOld = await insertKarenz(dueSeed({ customer, module: modules[1]!.module_id, state: 'finalized', switchedOff: '-60 days', finalAt: '-30 days', platformDone: '-29 days', tenantDone: '-29 days' }))
    // another customer's rows never show up
    await insertKarenz(seed({ module: modules[0]!.module_id }))

    // the window is a parameter: 14 days sees the recent restore, not the old finalize
    const ids = async (days: number) =>
      new Set((await list(council, customer, days)).map((x) => x.karenz_id as string))
    expect(await ids(14)).toEqual(new Set([live, restoring, finalizing, restoredRecent]))
    expect(await ids(0)).toEqual(new Set([live, restoring, finalizing]))
    expect(await ids(1)).toEqual(new Set([live, restoring, finalizing]))
    expect(await ids(60)).toEqual(new Set([live, restoring, finalizing, restoredRecent, finalizedOld]))

    const byId = new Map((await list(council, customer, 60)).map((x) => [x.karenz_id as string, x]))
    expect(byId.get(live)).toMatchObject({ state: 'open', module_key: modules[0]!.module_key, final_mode: null })
    expect(byId.get(finalizing)).toMatchObject({ state: 'finalizing', final_mode: 'live', module_key: modules[2]!.module_key })
    expect(byId.get(restoring)!.restore_requested_at).toBeInstanceOf(Date)
  })

  it('returns no actor_kind, actor_id or export_path column, in the result nor in the declared signature', async () => {
    const customer = randomUUID()
    await insertKarenz(seed({ customer }))
    const rows = await list(council, customer, 14)
    expect(rows.length).toBe(1)
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['export_kept_until', 'final_at', 'final_mode', 'karenz_id', 'module_key', 'platform_done_at', 'restore_requested_at', 'state', 'switched_off_at', 'tenant_done_at'],
    )
    const [sig] = await pa<{ res: string }[]>`SELECT pg_get_function_result('plt.council_karenz_list(uuid, integer)'::regprocedure) AS res`
    for (const banned of ['actor', 'export_path', 'export_sha256']) expect(sig!.res).not.toContain(banned)
  })

  it('a role outside plt_council_requester gets 42501 even with EXECUTE, and a bad window or customer is 22023', async () => {
    // give the panel role EXECUTE, so the refusal is the body's marker check and not a missing privilege
    await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${LIST} TO ${r.panelRole}`)
    await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${REPORT} TO ${r.panelRole}`)
    try {
      expect((await failure(list(r.panel, randomUUID(), 14)))?.code).toBe('42501')
      expect((await failure(report(r.panel, randomUUID(), randomUUID(), 'x', 'info', 'm')))?.code).toBe('42501')
      expect((await failure(list(r.owner, randomUUID(), 14)))?.code).toBe('42501')
    } finally {
      await pa.unsafe(`REVOKE ALL ON FUNCTION ${LIST} FROM ${r.panelRole}`)
      await pa.unsafe(`REVOKE ALL ON FUNCTION ${REPORT} FROM ${r.panelRole}`)
    }
    for (const days of [-1, 61, null]) expect((await failure(list(council, randomUUID(), days)))?.code, String(days)).toBe('22023')
    expect((await failure(list(council, null, 14)))?.code).toBe('22023')
  })

  it('PUBLIC has no EXECUTE on either council function and the council role holds no table privilege', async () => {
    for (const f of [LIST, REPORT]) {
      const [p] = await pa<{ pub: boolean }[]>`SELECT has_function_privilege('public', ${f}::regprocedure, 'EXECUTE') AS pub`
      expect(p!.pub, f).toBe(false)
    }
    for (const t of ['plt.module_karenz', 'plt.module_karenz_event']) {
      const [p] = await pa<{ s: boolean }[]>`SELECT has_table_privilege(${councilRole}, ${t}, 'SELECT,INSERT,UPDATE,DELETE') AS s`
      expect(p!.s, t).toBe(false)
    }
    expect((await failure(council`SELECT * FROM plt.module_karenz`))?.code).toBe('42501')
  })
})

describe('plt.council_karenz_report', () => {
  const lastEvent = async (id: string) =>
    (await pa<Record<string, unknown>[]>`SELECT level, step, message FROM plt.module_karenz_event WHERE karenz_id = ${id}::uuid ORDER BY at DESC, event_id DESC LIMIT 1`)[0]
  const events = async (id: string) => (await pa`SELECT 1 FROM plt.module_karenz_event WHERE karenz_id = ${id}::uuid`).length

  it('appends an event for the row of the asked customer', async () => {
    const s = seed()
    const id = await insertKarenz(s)
    await report(council, s.customer, id, 'notice:switchoff', 'info', 'sent 3, skipped 1')
    expect(await lastEvent(id)).toEqual({ level: 'info', step: 'notice:switchoff', message: 'sent 3, skipped 1' })
    expect((await row(id)).state).toBe('open')
  })

  it('mark tenant_done is refused (22023) before final_at and sets tenant_done_at after it; with platform_done_at already set the row becomes finalized', async () => {
    const early = seed()
    const earlyId = await insertKarenz(early)
    const refused = await failure(report(council, early.customer, earlyId, 'final', 'info', 'done', 'tenant_done'))
    expect(refused?.code).toBe('22023')
    expect(await events(earlyId), 'a refused mark leaves no event behind').toBe(0)
    expect((await row(earlyId)).has_tenant_done).toBe(false)

    const due = dueSeed({ finalMode: 'live' })
    const dueId = await insertKarenz(due)
    await report(council, due.customer, dueId, 'final', 'info', 'tenant side done', 'tenant_done')
    expect(await row(dueId)).toMatchObject({ state: 'open', has_tenant_done: true, has_platform_done: false })

    const both = dueSeed({ state: 'finalizing', platformDone: '-1 hour', finalMode: 'live' })
    const bothId = await insertKarenz(both)
    await report(council, both.customer, bothId, 'final', 'info', 'tenant side done', 'tenant_done')
    expect(await row(bothId)).toMatchObject({ state: 'finalized', has_tenant_done: true, has_platform_done: true })

    // a second tenant_done mark keeps the first timestamp
    const [t1] = await pa<{ t: Date }[]>`SELECT tenant_done_at AS t FROM plt.module_karenz WHERE karenz_id = ${dueId}::uuid`
    await report(council, due.customer, dueId, 'final', 'info', 'again', 'tenant_done')
    const [t2] = await pa<{ t: Date }[]>`SELECT tenant_done_at AS t FROM plt.module_karenz WHERE karenz_id = ${dueId}::uuid`
    expect(t2!.t.getTime()).toBe(t1!.t.getTime())
  })

  it('mark tenant_done is refused (22023) while final_mode is null or dry: a dry run deletes nothing, so no tenant side can be complete; the event rolls back with it', async () => {
    for (const finalMode of [null, 'dry'] as const) {
      for (const state of ['open', 'finalizing'] as const) {
        const s = dueSeed({ state, finalMode })
        const id = await insertKarenz(s)
        const f = await failure(report(council, s.customer, id, 'final', 'info', 'tenant side done', 'tenant_done'))
        expect(f?.code, `${state}/${finalMode}`).toBe('22023')
        expect(f?.message, `${state}/${finalMode}`).toContain('final_mode')
        expect(await events(id), `${state}/${finalMode}: a refused mark leaves no event behind`).toBe(0)
        expect((await row(id)).has_tenant_done, `${state}/${finalMode}`).toBe(false)
        // the same row still takes a plain event (the dry-run line the tenant side reports every 24 h)
        await report(council, s.customer, id, 'final:dry', 'info', 'deletion off: would delete: nothing')
        expect(await events(id)).toBe(1)
      }
    }
  })

  it('0016 keeps the grants of the two council functions: EXECUTE for the council role, none for PUBLIC', async () => {
    const rows = await pa<{ proname: string; public_exec: boolean }[]>`
      SELECT p.proname, coalesce((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), false) AS public_exec
        FROM pg_proc p WHERE p.pronamespace = 'plt'::regnamespace AND p.proname IN ('council_karenz_list', 'council_karenz_report') ORDER BY 1`
    expect(rows).toEqual([
      { proname: 'council_karenz_list', public_exec: false },
      { proname: 'council_karenz_report', public_exec: false },
    ])
    const [priv] = await pa<{ ok: boolean }[]>`SELECT has_function_privilege(${councilRole}, ${REPORT}, 'EXECUTE') AS ok`
    expect(priv!.ok).toBe(true)
  })

  it('mark tenant_done is refused for a restoring, restored or finalized row', async () => {
    for (const over of [
      { state: 'restoring', restoreRequested: '-1 hour' },
      { state: 'restored', restoreRequested: '-2 hours', restoredAt: '-1 hour' },
      { state: 'finalized', platformDone: '-2 hours', tenantDone: '-1 hour' },
    ] as const) {
      const s = dueSeed(over)
      const id = await insertKarenz(s)
      expect((await failure(report(council, s.customer, id, 'final', 'info', 'm', 'tenant_done')))?.code, over.state).toBe('22023')
    }
  })

  it('mark restored works only from state restoring', async () => {
    const open_ = seed()
    const openId = await insertKarenz(open_)
    expect((await failure(report(council, open_.customer, openId, 'restore', 'info', 'm', 'restored')))?.code).toBe('22023')
    expect((await row(openId)).state).toBe('open')

    const rest = seed({ state: 'restoring', restoreRequested: '-1 hour' })
    const restId = await insertKarenz(rest)
    await report(council, rest.customer, restId, 'restore', 'info', 'all steps done', 'restored')
    expect(await row(restId)).toMatchObject({ state: 'restored', has_restored_at: true })
    // a restored row is closed: the mark cannot be replayed
    expect((await failure(report(council, rest.customer, restId, 'restore', 'info', 'm', 'restored')))?.code).toBe('22023')
  })

  it('a completion mark on an error-level report is refused (22023) and closes nothing, with or without the platform side done', async () => {
    const lone = dueSeed({ finalMode: 'live' })
    const loneId = await insertKarenz(lone)
    expect((await failure(report(council, lone.customer, loneId, 'final', 'error', 'tenant pass failed', 'tenant_done')))?.code).toBe('22023')
    expect(await events(loneId), 'a refused mark leaves no event behind').toBe(0)
    expect(await row(loneId)).toMatchObject({ state: 'open', has_tenant_done: false })

    const both = dueSeed({ state: 'finalizing', platformDone: '-1 hour', finalMode: 'live' })
    const bothId = await insertKarenz(both)
    expect((await failure(report(council, both.customer, bothId, 'final', 'error', 'tenant pass failed', 'tenant_done')))?.code).toBe('22023')
    expect(await row(bothId)).toMatchObject({ state: 'finalizing', has_tenant_done: false, has_platform_done: true })

    const rest = seed({ state: 'restoring', restoreRequested: '-1 hour' })
    const restId = await insertKarenz(rest)
    expect((await failure(report(council, rest.customer, restId, 'restore', 'error', 'restore failed', 'restored')))?.code).toBe('22023')
    expect(await row(restId)).toMatchObject({ state: 'restoring', has_restored_at: false })
    expect(await events(restId)).toBe(0)

    // the failure itself is still reportable, as an event without a mark ...
    await report(council, lone.customer, loneId, 'final', 'error', 'tenant pass failed')
    expect(await lastEvent(loneId)).toEqual({ level: 'error', step: 'final', message: 'tenant pass failed' })
    // ... and the retry that succeeds closes the row
    await report(council, lone.customer, loneId, 'final', 'info', 'tenant side done', 'tenant_done')
    expect(await row(loneId)).toMatchObject({ has_tenant_done: true })
  })

  it('an unknown mark is 22023', async () => {
    const s = seed()
    const id = await insertKarenz(s)
    expect((await failure(report(council, s.customer, id, 'x', 'info', 'm', 'finalized')))?.code).toBe('22023')
    expect((await failure(report(council, s.customer, id, 'x', 'info', 'm', '')))?.code).toBe('22023')
  })

  it('an unknown level, a step with a space or a message over 1000 characters fails 22023 and leaves no event', async () => {
    const s = seed()
    const id = await insertKarenz(s)
    for (const [step, level, message] of [
      ['x', 'warn', 'm'],
      ['x', 'INFO', 'm'],
      ['has space', 'info', 'm'],
      ['Upper', 'info', 'm'],
      ['', 'info', 'm'],
      ['a'.repeat(61), 'info', 'm'],
      ['x', 'info', 'm'.repeat(1001)],
    ] as const) {
      expect((await failure(report(council, s.customer, id, step, level, message)))?.code, `${step}/${level}/${message.length}`).toBe('22023')
    }
    expect((await failure(report(council, s.customer, id, 'x', 'info', null as unknown as string)))?.code).toBe('22023')
    expect(await events(id)).toBe(0)
    // the longest valid values pass
    await report(council, s.customer, id, 'a'.repeat(60), 'error', 'm'.repeat(1000))
    expect(await events(id)).toBe(1)
  })

  it('a karenz_id that belongs to another customer, or does not exist, is refused', async () => {
    const mine = seed()
    const myId = await insertKarenz(mine)
    const other = seed({ module: modules[1]!.module_id })
    const otherId = await insertKarenz(other)
    expect((await failure(report(council, mine.customer, otherId, 'x', 'info', 'm')))?.code).toBe('22023')
    expect((await failure(report(council, other.customer, myId, 'x', 'info', 'm')))?.code).toBe('22023')
    expect((await failure(report(council, mine.customer, randomUUID(), 'x', 'info', 'm')))?.code).toBe('22023')
    expect((await failure(report(council, mine.customer, otherId, 'x', 'info', 'm', 'tenant_done')))?.code).toBe('22023')
    expect(await events(myId)).toBe(0)
    expect(await events(otherId)).toBe(0)
  })

  it('a report can never touch final_mode, final_at, the export columns or the platform side', async () => {
    const s = dueSeed({ state: 'finalizing', finalMode: 'live' })
    const id = await insertKarenz(s)
    await pa.unsafe(`UPDATE plt.module_karenz SET export_path = '/e/x.dump', export_sha256 = '${'c'.repeat(64)}' WHERE karenz_id = '${id}'`)
    const snap = async () =>
      (await pa<Record<string, unknown>[]>`SELECT final_mode, final_at, export_path, export_sha256, export_deleted_at, platform_done_at FROM plt.module_karenz WHERE karenz_id = ${id}::uuid`)[0]
    const before = await snap()
    await report(council, s.customer, id, 'final', 'info', 'tenant side done', 'tenant_done')
    expect(await snap()).toEqual(before)
  })
})

describe('migration 0015 constraints', () => {
  it('every constraint 0015 adds or re-adds is validated (pg_constraint.convalidated is true)', async () => {
    const rows = await pa<{ rel: string; conname: string; convalidated: boolean }[]>`
      SELECT conrelid::regclass::text AS rel, conname, convalidated FROM pg_constraint
       WHERE conrelid IN ('plt.module_database'::regclass, 'plt.module_karenz'::regclass, 'plt.module_karenz_event'::regclass)
         AND contype = 'c' ORDER BY 1, 2`
    const names = rows.map((x) => x.conname)
    for (const want of [
      'module_database_state_check',
      'module_database_blocked_export_check',
      'module_karenz_state_check',
      'module_karenz_final_after_off_check',
      'module_karenz_final_mode_check',
      'module_karenz_actor_kind_check',
      'module_karenz_event_level_check',
      'module_karenz_event_step_check',
      'module_karenz_event_message_check',
    ]) expect(names, want).toContain(want)
    expect(rows.filter((x) => !x.convalidated)).toEqual([])
  })

  it('both council functions are SECURITY DEFINER with a pinned search_path', async () => {
    const rows = await pa<{ proname: string; prosecdef: boolean; cfg: string[] | null }[]>`
      SELECT proname, prosecdef, proconfig AS cfg FROM pg_proc
       WHERE pronamespace = 'plt'::regnamespace AND proname IN ('council_karenz_list', 'council_karenz_report') ORDER BY 1`
    expect(rows.map((x) => x.proname)).toEqual(['council_karenz_list', 'council_karenz_report'])
    for (const x of rows) {
      expect(x.prosecdef, x.proname).toBe(true)
      expect(x.cfg, x.proname).toContain('search_path=pg_catalog, pg_temp')
    }
  })
})
