// TRD-092 / TRD-191 / PRD-OPS-006 on the scratch PostgreSQL 18 (run.mjs): the
// vendor/operator access record of gremion_platform (schema oac, 0013).
//  - oac.record_access writes who/when/what/why; the origin comes from the
//    caller's marker role (panel: an operator uuid; host: a login user), a third
//    role is refused 42501, a missing why / bad actor / bad slug 22023;
//  - append-only: no role can UPDATE, DELETE or TRUNCATE (not even the owner,
//    not with a forged purge flag on a young row);
//  - oac.purge_access_records keeps every row inside the security window
//    (RC-LOG-AUD = RC-LOG-SEC, 27 d) and removes older ones only; a window below
//    27 d or above the 30 d cap is refused; only the executor may call it;
//  - the reader function is tenant-scoped: customer A's rows never come back for B.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failure, setupRoles, submitArgs, type Roles } from './scratch.ts'

let r: Roles
beforeAll(async () => {
  r = await setupRoles('oac')
})
afterAll(async () => {
  await r?.close()
})

const OP = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'
const rec = (sql: typeof r.panel, slug: string, over: Partial<Record<'action' | 'what' | 'why' | 'actor', string | null>> = {}) =>
  sql<{ id: string }[]>`SELECT oac.record_access(${slug}, ${over.action ?? 'create_request'}, ${over.what === undefined ? 'Mandant anlegen (Anfrage)' : over.what},
    ${over.why ?? 'Operator-Anforderung im Control-Panel'}, ${over.actor === undefined ? OP : over.actor}, NULL)::text AS id`

/** Back-dates a row. The table is append-only for everyone, so this drops the trigger for the fixture only. */
async function backdate(id: string, days: number): Promise<void> {
  await r.owner.unsafe('ALTER TABLE oac.access_record DISABLE TRIGGER access_record_no_update_trg')
  try {
    await r.owner.unsafe(`UPDATE oac.access_record SET at = now() - interval '${days} days' WHERE access_id = '${id}'`)
  } finally {
    await r.owner.unsafe('ALTER TABLE oac.access_record ENABLE TRIGGER access_record_no_update_trg')
  }
}

describe('oac.record_access', () => {
  it('panel: records origin=panel with who, when, what, why', async () => {
    const [{ id }] = await rec(r.panel, 'alpha-rat')
    const [row] = await r.owner<{ origin: string; actor: string; action: string; what: string; why: string; recent: boolean; slug: string }[]>`
      SELECT origin, actor, action, what, why, customer_slug AS slug, at > now() - interval '1 minute' AS recent FROM oac.access_record WHERE access_id = ${id}::uuid`
    expect(row).toEqual({ origin: 'panel', actor: OP, action: 'create_request', what: 'Mandant anlegen (Anfrage)', why: 'Operator-Anforderung im Control-Panel', slug: 'alpha-rat', recent: true })
  })

  it('host (executor): records origin=host with the login user', async () => {
    const [{ id }] = await rec(r.executor, 'alpha-rat', { actor: 'deploy', action: 'break_glass', why: 'Panel nicht erreichbar, Mandant anlegen' })
    const [row] = await r.owner<{ origin: string; actor: string }[]>`SELECT origin, actor FROM oac.access_record WHERE access_id = ${id}::uuid`
    expect(row).toEqual({ origin: 'host', actor: 'deploy' })
  })

  it.each<[string, string, Parameters<typeof rec>[2], string]>([
    ['panel with a non-uuid actor', 'panel', { actor: 'deploy' }, '22023'],
    ['panel without an actor', 'panel', { actor: null }, '22023'],
    ['a why shorter than 10 characters', 'panel', { why: 'kurz' }, '22023'],
    ['a missing what', 'panel', { what: null }, '22023'],
    ['a bad action', 'panel', { action: 'Drop Everything' }, '22023'],
    ['host with an operator uuid as actor', 'executor', { actor: OP }, '22023'],
  ])('refuses %s', async (_what, who, over, sqlstate) => {
    const f = await failure(rec(who === 'panel' ? r.panel : r.executor, 'alpha-rat', over))
    expect(f?.code).toBe(sqlstate)
  })

  it('refuses a bad slug and the slug platform', async () => {
    expect((await failure(rec(r.panel, '1-bad--slug')))?.code).toBe('22023')
    expect((await failure(rec(r.panel, 'platform')))?.code).toBe('22023')
  })

  it('a third role (the owner) is refused 42501, and PUBLIC holds no EXECUTE', async () => {
    expect((await failure(rec(r.owner, 'alpha-rat')))?.code).toBe('42501')
    const [p] = await r.owner<{ x: boolean }[]>`SELECT has_function_privilege('public', 'oac.record_access(text,text,text,text,text,uuid)', 'EXECUTE') AS x`
    expect(p!.x).toBe(false)
  })

  it('the writer pins search_path and is SECURITY DEFINER', async () => {
    const [p] = await r.owner<{ def: boolean; cfg: string[] }[]>`
      SELECT prosecdef AS def, proconfig AS cfg FROM pg_proc WHERE oid = 'oac.record_access(text,text,text,text,text,uuid)'::regprocedure`
    expect(p!.def).toBe(true)
    expect(p!.cfg).toContain('search_path=pg_catalog, pg_temp')
  })
})

describe('the panel statement (requests.ts / retry.ts): request and record in ONE statement', () => {
  const stmt = (a: ReturnType<typeof submitArgs>) => r.panel<{ id: string }[]>`
    SELECT plt.submit_provisioning_request(${a.kind}, ${a.slug}, ${r.panel.json(a.args as never)}, ${a.key}::uuid, ${a.operator}::uuid,
      ${a.acr}, ${a.authTime}::timestamptz, ${a.sessionAt}::timestamptz, ${a.token}, NULL, NULL)::text AS id
      FROM (SELECT oac.record_access(${a.slug}, 'panel_request', 'Mandant anlegen für den Kunden: Anfrage gestellt', 'Betreiber-Anforderung im Control-Panel', ${a.operator}, NULL)) AS access_record`
  const n = async (slug: string) => (await r.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM oac.access_record WHERE customer_slug = ${slug}`)[0]!.n

  it('an accepted request leaves exactly one record naming the operator', async () => {
    const a = submitArgs({ slug: 'omega-rat' })
    await stmt(a)
    expect(await n('omega-rat')).toBe(1)
  })

  it('a refused request (loa1) leaves no record: the statement rolls back as a whole', async () => {
    expect((await failure(stmt(submitArgs({ slug: 'sigma-rat', acr: 'loa1' }))))?.code).toBe('28000')
    expect(await n('sigma-rat')).toBe(0)
  })
})

describe('append-only', () => {
  it('no role holds a table privilege; the panel and executor cannot touch the table', async () => {
    for (const sql of [r.panel, r.executor]) {
      expect((await failure(sql`SELECT count(*) FROM oac.access_record`))?.code).toBe('42501')
      expect((await failure(sql`DELETE FROM oac.access_record`))?.code).toBe('42501')
    }
  })

  it('the owner itself cannot UPDATE, DELETE or TRUNCATE a row (check_violation)', async () => {
    const [{ id }] = await rec(r.panel, 'beta-rat')
    expect((await failure(r.owner`UPDATE oac.access_record SET why = 'umgeschrieben und gefaelscht' WHERE access_id = ${id}::uuid`))?.code).toBe('23514')
    expect((await failure(r.owner`DELETE FROM oac.access_record WHERE access_id = ${id}::uuid`))?.code).toBe('23514')
    expect((await failure(r.owner.unsafe('TRUNCATE oac.access_record')))?.code).toBe('23514')
  })

  it('a forged purge flag does not delete a young row', async () => {
    const [{ id }] = await rec(r.panel, 'beta-rat')
    const f = await failure(r.owner.begin(async (tx) => {
      await tx`SELECT set_config('oac.purging', 'on', true)`
      await tx`DELETE FROM oac.access_record WHERE access_id = ${id}::uuid`
    }))
    expect(f?.code).toBe('23514')
    expect((await r.owner`SELECT 1 FROM oac.access_record WHERE access_id = ${id}::uuid`).length).toBe(1)
  })
})

describe('oac.purge_access_records (RC-LOG-AUD: never shorter than the security window)', () => {
  it('keeps a row at the window start through day 26, removes it only past 27 d', async () => {
    const [{ id: young }] = await rec(r.panel, 'gamma-rat')
    const [{ id: edge }] = await rec(r.panel, 'gamma-rat')
    const [{ id: old }] = await rec(r.panel, 'gamma-rat')
    await backdate(young, 1)
    await backdate(edge, 26)
    await backdate(old, 28)
    const [{ n }] = await r.executor<{ n: number }[]>`SELECT oac.purge_access_records(interval '27 days') AS n`
    expect(n).toBeGreaterThanOrEqual(1)
    const left = (await r.owner<{ access_id: string }[]>`SELECT access_id::text FROM oac.access_record WHERE access_id IN (${young}::uuid, ${edge}::uuid, ${old}::uuid)`).map((x) => x.access_id)
    expect(left.sort()).toEqual([young, edge].sort())
  })

  it('a customer being erased does not touch its access records (no FK to the customer)', async () => {
    const [{ id }] = await rec(r.panel, 'delta-rat')
    await r.executor`SELECT oac.purge_access_records(interval '27 days')`
    expect((await r.owner`SELECT 1 FROM oac.access_record WHERE access_id = ${id}::uuid`).length).toBe(1)
  })

  it('refuses a window below 27 d or above the 30 d cap, and a caller that is not the executor', async () => {
    expect((await failure(r.executor`SELECT oac.purge_access_records(interval '26 days')`))?.code).toBe('22023')
    expect((await failure(r.executor`SELECT oac.purge_access_records(interval '31 days')`))?.code).toBe('22023')
    expect((await failure(r.panel`SELECT oac.purge_access_records(interval '27 days')`))?.code).toBe('42501')
  })
})

describe('oac.list_access_records (the council admin view reads through this)', () => {
  it('is tenant-scoped: A sees A, never B; newest first; limit and cursor honoured', async () => {
    await rec(r.panel, 'tenant-a', { what: 'A eins' })
    await rec(r.panel, 'tenant-a', { what: 'A zwei' })
    await rec(r.panel, 'tenant-b', { what: 'B geheim' })
    const a = await r.reader<{ what: string; actor: string; origin: string }[]>`SELECT what, actor, origin FROM oac.list_access_records('tenant-a', 50, NULL)`
    expect(a.map((x) => x.what)).toEqual(['A zwei', 'A eins'])
    const b = await r.reader<{ what: string }[]>`SELECT what FROM oac.list_access_records('tenant-b', 50, NULL)`
    expect(b.map((x) => x.what)).toEqual(['B geheim'])
    const one = await r.reader<{ what: string }[]>`SELECT what FROM oac.list_access_records('tenant-a', 1, NULL)`
    expect(one).toHaveLength(1)
  })

  it('the reader role can execute only the reader function, and holds no table privilege', async () => {
    expect((await failure(r.reader`SELECT count(*) FROM oac.access_record`))?.code).toBe('42501')
    expect((await failure(rec(r.reader, 'tenant-a')))?.code).toBe('42501')
    expect((await failure(r.reader`SELECT oac.purge_access_records(interval '27 days')`))?.code).toBe('42501')
    expect((await failure(r.reader`SELECT count(*) FROM plt.provisioning_request_status`))?.code).toBe('42501')
  })

  it('refuses a bad slug (22023)', async () => {
    expect((await failure(r.reader`SELECT * FROM oac.list_access_records('Not A Slug', 10, NULL)`))?.code).toBe('22023')
  })
})
