// Module self-service, phase 1, Task 1 on the scratch PostgreSQL 18 (run.mjs):
// the council origin of plt.provisioning_request and the three council request
// functions of gremion_platform (migration 0014).
//  - plt.submit_council_module_request: the ONE write a council's gremion-ui makes.
//    Origin council, actor_kind person, loa2 evidence, at most one request per
//    customer slug in flight (55006), idempotent on its key (same payload -> same
//    id, other payload -> 23505), only enable_module / disable_module (22023);
//  - the envelope guard and the CHECKs keep a council row a council row;
//  - plt.council_module_requests reads origin-council rows of ONE slug and never
//    the evidence token; plt.council_module_state is the catalogue-wide state;
//  - every constraint the migration adds is validated.
// The council LOGIN role is made here by hand (marker membership + EXECUTE on the
// three functions): ensureCouncilRequester is Task 2.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failure, open, setupRoles, submit, submitArgs, type Roles } from './scratch.ts'

const MARKER = 'plt_council_requester'
const SUBMIT = 'plt.submit_council_module_request(text, text, jsonb, uuid, uuid, text, timestamptz, text)'
const REQUESTS = 'plt.council_module_requests(text, integer)'
const STATE = 'plt.council_module_state(uuid)'
const PERSON = '7c1d3a8e-52b4-4f0e-9a61-3d2f8b0c4e11'

let r: Roles
/** A superuser pool ON gremion_platform: fixtures and the documented trigger/CHECK bypass checks. */
let pa: ReturnType<typeof open>
/** A pool AS the hand-made council role. */
let council: ReturnType<typeof open>
const councilRole = 't043d_council_ui'
const councilPassword = randomBytes(24).toString('base64url')

beforeAll(async () => {
  r = await setupRoles('council')
  pa = open('gremion_platform', 2)
  await r.admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MARKER}') THEN CREATE ROLE ${MARKER} NOLOGIN; END IF; END $$`)
  await r.admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${councilRole}') THEN CREATE ROLE ${councilRole} LOGIN NOINHERIT PASSWORD '${councilPassword}'; END IF; END $$`)
  // a kept server (vitest watch) already has the role with the previous run's password
  await r.admin.unsafe(`ALTER ROLE ${councilRole} PASSWORD '${councilPassword}'`)
  await r.admin.unsafe(`GRANT ${MARKER} TO ${councilRole} WITH INHERIT FALSE, SET FALSE`)
  await r.admin.unsafe(`GRANT CONNECT ON DATABASE gremion_platform TO ${councilRole}`)
  await pa.unsafe(`GRANT USAGE ON SCHEMA plt TO ${councilRole}`)
  for (const f of [SUBMIT, REQUESTS, STATE]) await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${f} TO ${councilRole}`)
  council = open('gremion_platform', 2, councilRole, councilPassword)
})
afterAll(async () => {
  await council?.end({ timeout: 5 })
  await pa?.end({ timeout: 5 })
  await r?.close()
})

/** A unique valid slug per test (one request in flight per customer is the rule under test). */
let n = 0
const slug = () => `cnl-${process.pid}-${++n}`.slice(0, 30)

interface CouncilArgs {
  kind: string | null
  slug: string | null
  args: unknown
  key: string | null
  person: string | null
  acr: string | null
  authTime: Date | null
  token: string | null
}
function councilArgs(over: Partial<CouncilArgs> = {}): CouncilArgs {
  const s = over.slug ?? slug()
  return {
    kind: 'enable_module',
    slug: s,
    args: { slug: s, module: 'votes', dpia: null },
    key: crypto.randomUUID(),
    person: PERSON,
    acr: 'loa2',
    authTime: new Date(Date.now() - 60_000),
    token: 'c'.repeat(300),
    ...over,
  }
}
const submitCouncil = (sql: ReturnType<typeof open>, a: CouncilArgs) =>
  sql<{ id: string }[]>`
    SELECT plt.submit_council_module_request(${a.kind}, ${a.slug}, ${a.args === null ? null : sql.json(a.args as never)}, ${a.key}::uuid, ${a.person}::uuid,
      ${a.acr}, ${a.authTime}::timestamptz, ${a.token})::text AS id`

const row = async (id: string) =>
  (
    await pa<Record<string, unknown>[]>`
      SELECT origin, actor_kind, kind, evidence_acr, evidence_session_at IS NOT NULL AS has_session_at, reason, host_actor, operator_id::text AS operator, state
        FROM plt.provisioning_request WHERE request_id = ${id}::uuid`
  )[0]!
const finish = async (id: string) => {
  await pa.unsafe(`UPDATE plt.provisioning_request SET state = 'running', claimed_by = 'h1.example', lease_until = now() + interval '1 hour' WHERE request_id = '${id}'`)
  await pa.unsafe(`UPDATE plt.provisioning_request SET state = 'succeeded', finished_at = now(), evidence_token = NULL WHERE request_id = '${id}'`)
}

describe('plt.submit_council_module_request', () => {
  it('council role submits enable_module and the row has origin council, actor_kind person, evidence_acr loa2, session_at set, reason and host_actor null', async () => {
    const a = councilArgs()
    const [{ id }] = (await submitCouncil(council, a)) as unknown as [{ id: string }]
    expect(await row(id)).toEqual({
      origin: 'council',
      actor_kind: 'person',
      kind: 'enable_module',
      evidence_acr: 'loa2',
      has_session_at: true,
      reason: null,
      host_actor: null,
      operator: PERSON,
      state: 'queued',
    })
  })

  it('a council disable_module is accepted at the database level (the phase 1 refusal lives in the library, not in SQL)', async () => {
    const a = councilArgs({ kind: 'disable_module' })
    a.args = { slug: a.slug, module: 'votes' }
    const [{ id }] = (await submitCouncil(council, a)) as unknown as [{ id: string }]
    expect((await row(id)).kind).toBe('disable_module')
  })

  it('a panel-marker role calling submit_council_module_request fails 42501; the council role calling plt.submit_provisioning_request fails 42501', async () => {
    // give each role EXECUTE on the OTHER function, so the refusal is the body's marker check and not a missing privilege
    await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${SUBMIT} TO ${r.panelRole}`)
    const sig = 'plt.submit_provisioning_request(text, text, jsonb, uuid, uuid, text, timestamptz, timestamptz, text, text, text)'
    await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${sig} TO ${councilRole}`)
    try {
      const a = councilArgs()
      expect((await failure(submitCouncil(r.panel, a)))?.code).toBe('42501')
      expect((await failure(submit(council, submitArgs({ slug: slug() }))))?.code).toBe('42501')
      expect((await failure(submitCouncil(r.owner, councilArgs())))?.code).toBe('42501')
      expect((await pa`SELECT 1 FROM plt.provisioning_request WHERE idempotency_key = ${a.key}::uuid`).length).toBe(0)
    } finally {
      await pa.unsafe(`REVOKE ALL ON FUNCTION ${SUBMIT} FROM ${r.panelRole}`)
      await pa.unsafe(`REVOKE ALL ON FUNCTION ${sig} FROM ${councilRole}`)
    }
  })

  it.each(['create', 'suspend', 'reconcile', 'record_dpia'])('kind %s fails 22023', async (kind) => {
    const a = councilArgs({ kind })
    expect((await failure(submitCouncil(council, a)))?.code).toBe('22023')
    expect((await pa`SELECT 1 FROM plt.provisioning_request WHERE idempotency_key = ${a.key}::uuid`).length).toBe(0)
  })

  it.each<[string, () => Partial<CouncilArgs>, string]>([
    ['acr loa1', () => ({ acr: 'loa1' }), '28000'],
    ['acr absent', () => ({ acr: null }), '28000'],
    ['sign-in 3601 s old', () => ({ authTime: new Date(Date.now() - 3601_000) }), '28000'],
    ['sign-in 61 s in the future', () => ({ authTime: new Date(Date.now() + 61_000) }), '28000'],
    ['no sign-in time', () => ({ authTime: null }), '28000'],
    ['a 99-character token', () => ({ token: 'c'.repeat(99) }), '28000'],
    ['no token', () => ({ token: null }), '28000'],
    ['an 8193-character token', () => ({ token: 'c'.repeat(8193) }), '28000'],
    ['NULL person', () => ({ person: null }), '22023'],
    ['an invalid slug', () => ({ slug: '1-bad--slug', args: { x: 1 } }), '22023'],
    ['slug platform', () => ({ slug: 'platform', args: { x: 1 } }), '22023'],
    ['args an array', () => ({ args: ['x'] }), '22023'],
    ['args over 16 KiB', () => ({ args: { pad: 'x'.repeat(16_400) } }), '22023'],
    ['no idempotency key', () => ({ key: null }), '22023'],
  ])('refuses: %s', async (_what, over, sqlstate) => {
    const a = councilArgs(over())
    expect((await failure(submitCouncil(council, a)))?.code).toBe(sqlstate)
    // nothing was queued for that slug (by slug, so the case without an idempotency key is checked too)
    expect((await pa`SELECT 1 FROM plt.provisioning_request WHERE customer_slug = ${a.slug}`).length).toBe(0)
  })

  it('a second submit for the same slug while one is queued fails 55006; after the first is finished it succeeds', async () => {
    const s = slug()
    const [{ id }] = (await submitCouncil(council, councilArgs({ slug: s }))) as unknown as [{ id: string }]
    const second = councilArgs({ slug: s })
    expect((await failure(submitCouncil(council, second)))?.code).toBe('55006')
    // a RUNNING request blocks as well
    await pa.unsafe(`UPDATE plt.provisioning_request SET state = 'running', claimed_by = 'h1.example', lease_until = now() + interval '1 hour' WHERE request_id = '${id}'`)
    expect((await failure(submitCouncil(council, second)))?.code).toBe('55006')
    await pa.unsafe(`UPDATE plt.provisioning_request SET state = 'succeeded', finished_at = now(), evidence_token = NULL WHERE request_id = '${id}'`)
    expect(await failure(submitCouncil(council, second))).toBeNull()
    expect((await pa`SELECT 1 FROM plt.provisioning_request WHERE customer_slug = ${s}`).length).toBe(2)
  })

  it('a request of another origin in flight for the slug blocks a council request too', async () => {
    const s = slug()
    const p = submitArgs({ slug: s, args: { slug: s } })
    await submit(r.panel, p)
    expect((await failure(submitCouncil(council, councilArgs({ slug: s }))))?.code).toBe('55006')
  })

  it('same idempotency key and same payload returns the same request_id (even while it is queued); same key different payload fails 23505', async () => {
    const a = councilArgs()
    const [first] = (await submitCouncil(council, a)) as unknown as [{ id: string }]
    const [again] = (await submitCouncil(council, a)) as unknown as [{ id: string }]
    expect(again.id).toBe(first.id)
    expect((await pa`SELECT 1 FROM plt.provisioning_request WHERE idempotency_key = ${a.key}::uuid`).length).toBe(1)
    expect((await failure(submitCouncil(council, { ...a, args: { slug: a.slug, module: 'calendar', dpia: null } })))?.code).toBe('23505')
    // the same key for another slug is refused too (a key names one request)
    expect((await failure(submitCouncil(council, { ...a, slug: slug() })))?.code).toBe('23505')
  })
})

describe('the council envelope', () => {
  it('a council row cannot be changed to kind create or origin panel (envelope guard), nor its actor_kind', async () => {
    const [{ id }] = (await submitCouncil(council, councilArgs())) as unknown as [{ id: string }]
    for (const set of ["kind = 'create'", "origin = 'panel'", "actor_kind = 'operator'", "operator_id = '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33'"]) {
      const f = await failure(pa.unsafe(`UPDATE plt.provisioning_request SET ${set} WHERE request_id = '${id}'`))
      expect(f?.code, set).toBe('23514')
      expect(f?.message, set).toMatch(/envelope is immutable/)
    }
  })

  it('the CHECK refuses origin council with kind create even via a superuser INSERT', async () => {
    const f = await failure(
      pa.unsafe(`INSERT INTO plt.provisioning_request (kind, customer_slug, args, idempotency_key, origin, operator_id, actor_kind, evidence_acr, evidence_auth_time, evidence_session_at)
                 VALUES ('create', 'cnl-direct-1', '{}', '${crypto.randomUUID()}', 'council', '${PERSON}', 'person', 'loa2', now(), now())`),
    )
    expect(f?.code).toBe('23514')
    expect(f?.message).toMatch(/provisioning_request_council_kind_check/)
  })

  it('the CHECKs tie origin council to actor_kind person and to loa2 evidence without reason or host actor', async () => {
    const base = (o: string, actor: string, acr: string | null, reason: string | null) =>
      pa.unsafe(`INSERT INTO plt.provisioning_request (kind, customer_slug, args, idempotency_key, origin, operator_id, actor_kind, evidence_acr, evidence_auth_time, evidence_session_at, reason)
                 VALUES ('enable_module', 'cnl-direct-2', '{}', '${crypto.randomUUID()}', '${o}', '${PERSON}', '${actor}', ${acr ? `'${acr}'` : 'NULL'}, ${acr ? 'now()' : 'NULL'}, ${acr ? 'now()' : 'NULL'}, ${reason ? `'${reason}'` : 'NULL'})`)
    // positive control: the fixture itself is a valid council row, so the refusals below are about their one changed field
    expect(await failure(base('council', 'person', 'loa2', null))).toBeNull()
    // Postgres checks CHECK constraints in name order; the constraint that fires is named in the message
    const negatives: [string, string, string | null, string | null, RegExp][] = [
      ['council', 'operator', 'loa2', null, /provisioning_request_actor_origin_check/],
      ['panel', 'person', 'loa2', null, /provisioning_request_actor_origin_check/],
      ['council', 'person', 'loa1', null, /provisioning_request_evidence_check/],
      ['council', 'person', 'loa2', 'a break-glass reason', /provisioning_request_evidence_check/],
      ['council', 'person', null, null, /provisioning_request_evidence_check/],
      // an unknown origin fails the evidence check first (name order) and the origin check as well
      ['elsewhere', 'operator', 'loa2', null, /provisioning_request_(evidence|origin)_check/],
    ]
    for (const [o, actor, acr, reason, constraint] of negatives) {
      const f = await failure(base(o, actor, acr, reason))
      expect(f?.code, `${o}/${actor}/${acr}/${reason}`).toBe('23514')
      expect(f?.message, `${o}/${actor}/${acr}/${reason}`).toMatch(constraint)
    }
  })

  it('every constraint 0014 adds is validated (pg_constraint.convalidated is true)', async () => {
    const rows = await pa<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'plt.provisioning_request'::regclass AND contype = 'c' ORDER BY 1`
    const names = rows.map((x) => x.conname)
    for (const want of [
      'provisioning_request_actor_kind_check',
      'provisioning_request_origin_check',
      'provisioning_request_evidence_check',
      'provisioning_request_council_kind_check',
      'provisioning_request_actor_origin_check',
    ]) expect(names, want).toContain(want)
    expect(rows.filter((x) => !x.convalidated)).toEqual([])
  })

  it('a panel request is stored with actor_kind operator, and operator is the column default for every older row', async () => {
    const s = slug()
    const [{ id }] = (await submit(r.panel, submitArgs({ slug: s, args: { slug: s } }))) as unknown as [{ id: string }]
    expect((await row(id)).actor_kind).toBe('operator')
    const [d] = await pa<{ def: string }[]>`
      SELECT pg_get_expr(a.adbin, a.adrelid) AS def FROM pg_attrdef a JOIN pg_attribute c ON c.attrelid = a.adrelid AND c.attnum = a.adnum
       WHERE a.adrelid = 'plt.provisioning_request'::regclass AND c.attname = 'actor_kind'`
    expect(d!.def).toMatch(/'operator'/)
  })
})

describe('plt.council_module_requests', () => {
  it('returns only origin council rows of the slug asked for and never the evidence token column', async () => {
    const a = slug()
    const b = slug()
    const mine = councilArgs({ slug: a })
    const [{ id: idA }] = (await submitCouncil(council, mine)) as unknown as [{ id: string }]
    await finish(idA)
    const [{ id: idA2 }] = (await submitCouncil(council, councilArgs({ slug: a, args: { slug: a, module: 'calendar', dpia: null } }))) as unknown as [{ id: string }]
    // idA2 stays queued with its evidence token set: the token is in the table but must not be returned.
    // A panel row of the same slug and a council row of another slug must not show up either.
    expect((await pa`SELECT 1 FROM plt.provisioning_request WHERE request_id = ${idA2}::uuid AND evidence_token IS NOT NULL`).length).toBe(1)
    await submit(r.panel, submitArgs({ slug: a, args: { slug: a } }))
    await submitCouncil(council, councilArgs({ slug: b }))
    const rows = await council<Record<string, unknown>[]>`SELECT * FROM plt.council_module_requests(${a}, 20)`
    expect(rows.map((x) => x.request_id)).toEqual([idA2, idA])
    expect(Object.keys(rows[0]!).sort()).toEqual(['actor', 'created_at', 'finished_at', 'kind', 'module', 'outcome', 'request_id', 'state'])
    expect(rows[0]).toMatchObject({ kind: 'enable_module', module: 'calendar', state: 'queued', actor: PERSON })
    expect(rows[1]).toMatchObject({ module: 'votes', state: 'succeeded' })
    expect(JSON.stringify(rows)).not.toContain('ccccc')
  })

  it('p_limit is clamped to 1..100 by refusal (22023) and limits the rows', async () => {
    const a = slug()
    const [{ id }] = (await submitCouncil(council, councilArgs({ slug: a }))) as unknown as [{ id: string }]
    await finish(id)
    await submitCouncil(council, councilArgs({ slug: a }))
    expect((await council`SELECT * FROM plt.council_module_requests(${a}, 1)`).length).toBe(1)
    for (const lim of [0, 101, -1]) expect((await failure(council`SELECT * FROM plt.council_module_requests(${a}, ${lim})`))?.code, String(lim)).toBe('22023')
    expect((await failure(council`SELECT * FROM plt.council_module_requests(${'1-bad--slug'}, 10)`))?.code).toBe('22023')
  })

  it('a role outside the council marker is refused 42501', async () => {
    await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${REQUESTS} TO ${r.panelRole}`)
    try {
      expect((await failure(r.panel`SELECT * FROM plt.council_module_requests(${slug()}, 10)`))?.code).toBe('42501')
    } finally {
      await pa.unsafe(`REVOKE ALL ON FUNCTION ${REQUESTS} FROM ${r.panelRole}`)
    }
  })
})

describe('plt.council_module_state', () => {
  const CUSTOMER = '0b9e7f6a-1d2c-4a3b-8c5d-6e7f8091a2b3'
  const state = (customer = CUSTOMER) =>
    council<{ module_key: string; name: string; state: string; has_row: boolean; dpia_recorded: boolean }[]>`SELECT * FROM plt.council_module_state(${customer}::uuid)`

  it('lists every toggleable catalogue module with state disabled and has_row false for a customer that never enabled anything', async () => {
    const rows = await state(crypto.randomUUID())
    const keys = rows.map((x) => x.module_key)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).toEqual([...keys].sort())
    expect(keys).toContain('votes')
    expect(rows.every((x) => x.state === 'disabled' && !x.has_row && !x.dpia_recorded)).toBe(true)
    const [catalogue] = await pa<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.module WHERE toggleable`
    expect(rows.length).toBe(catalogue!.n)
  })

  it('has_row is false for a catalogue module that was never enabled and true after the first enablement row', async () => {
    const c = crypto.randomUUID()
    expect((await state(c)).find((x) => x.module_key === 'votes')).toMatchObject({ has_row: false, state: 'disabled' })
    await pa`
      INSERT INTO plt.module_enablement (customer_id, module_id, module_version_id, state, created_by_kind, updated_by_kind)
      SELECT ${c}::uuid, m.module_id, v.module_version_id, 'awaiting_isolation_test', 'system', 'system'
        FROM plt.module m JOIN plt.module_version v USING (module_id) WHERE m.module_key = 'votes' LIMIT 1`
    expect((await state(c)).find((x) => x.module_key === 'votes')).toMatchObject({ has_row: true, state: 'awaiting_isolation_test' })
    expect((await state(c)).find((x) => x.module_key === 'calendar')).toMatchObject({ has_row: false, state: 'disabled' })
  })

  it('marks dpia_recorded false until an ops.dpia_decision with document_ref exists, and reads the LATEST decision', async () => {
    const c = crypto.randomUUID()
    const decide = (requires: string, ref: string | null) => pa`
      INSERT INTO ops.dpia_decision (customer_id, module_id, requires_dpia, reason_codes, document_ref, decided_by_kind, decided_by)
      SELECT ${c}::uuid, m.module_id, ${requires}, ARRAY['council_decision'], ${ref}, 'person', ${PERSON}::uuid FROM plt.module m WHERE m.module_key = 'votes'`
    expect((await state(c)).find((x) => x.module_key === 'votes')!.dpia_recorded).toBe(false)
    await decide('no', null)
    expect((await state(c)).find((x) => x.module_key === 'votes')!.dpia_recorded).toBe(false)
    await pa.unsafe('SELECT pg_sleep(0.01)')
    await decide('no', 'dsb-vermerk-2026-10')
    const after = await state(c)
    expect(after.find((x) => x.module_key === 'votes')!.dpia_recorded).toBe(true)
    expect(after.find((x) => x.module_key === 'calendar')!.dpia_recorded).toBe(false)
    // another customer's decision does not leak
    expect((await state(crypto.randomUUID())).find((x) => x.module_key === 'votes')!.dpia_recorded).toBe(false)
  })

  it('a role outside the council marker is refused 42501', async () => {
    await pa.unsafe(`GRANT EXECUTE ON FUNCTION ${STATE} TO ${r.panelRole}`)
    try {
      expect((await failure(r.panel`SELECT * FROM plt.council_module_state(${crypto.randomUUID()}::uuid)`))?.code).toBe('42501')
    } finally {
      await pa.unsafe(`REVOKE ALL ON FUNCTION ${STATE} FROM ${r.panelRole}`)
    }
  })
})

describe('the council functions are locked down', () => {
  it('SECURITY DEFINER with a pinned search_path, and PUBLIC holds no EXECUTE', async () => {
    const rows = await pa<{ sig: string; def: boolean; cfg: string[]; pub: boolean }[]>`
      SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS def, p.proconfig AS cfg, has_function_privilege('public', p.oid, 'EXECUTE') AS pub
        FROM pg_proc p WHERE p.pronamespace = 'plt'::regnamespace AND p.proname IN ('submit_council_module_request', 'council_module_requests', 'council_module_state')`
    expect(rows.length).toBe(3)
    for (const x of rows) {
      expect(x.def, x.sig).toBe(true)
      expect(x.cfg, x.sig).toContain('search_path=pg_catalog, pg_temp')
      expect(x.pub, x.sig).toBe(false)
    }
  })

  it('the council role holds no table privilege in plt', async () => {
    const [x] = await pa<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class c WHERE c.relnamespace = 'plt'::regnamespace AND c.relkind IN ('r', 'v')
         AND has_table_privilege(${councilRole}, c.oid, 'SELECT, INSERT, UPDATE, DELETE')`
    expect(x!.n).toBe(0)
  })
})
