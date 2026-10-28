// TASK-043d-1 TDD 3, 4 and 5 on the scratch PostgreSQL 18 (run.mjs):
//  - A2: plt.submit_provisioning_request refuses, each with its SQLSTATE and
//    message quoted: acr loa1; a NULL or non-uuid operator; a sign-in older
//    than 3600 s or more than 60 s ahead; no evidence token; an invalid slug
//    or `platform`; args not an object or over 16 KiB; an unknown kind; a
//    reason from the panel; a host request without one; any third role.
//    Idempotency: the same key and content give the same id (one row); the
//    same key with other content is refused;
//  - TDD 4: the envelope is immutable, the token only clears, the state
//    machine only moves forward, nothing is deleted or truncated;
//  - TDD 5 / A6: claims under concurrency, one running request per customer
//    (the partial unique index), lease expiry with attempt + 1 and `dead` on
//    the third, requeue_own at executor start, an unclaimed request expiring.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failure, open, setupRoles, submit, submitArgs, type Roles } from './scratch.ts'

let r: Roles

beforeAll(async () => {
  r = await setupRoles('req')
})
afterAll(async () => {
  await r?.close()
})

const HOST = 'h1.example'
const count = async (key: string) => (await r.owner<{ n: number }[]>`SELECT count(*)::int AS n FROM plt.provisioning_request WHERE idempotency_key = ${key}::uuid`)[0]!.n
const quote = (what: string, f: { code: string; message: string } | null) => console.log(`[A2] ${what}: ${f ? `${f.code} ${f.message}` : 'ACCEPTED'}`)

/** A unique valid slug per test (one running request per customer is the index under test). */
let n = 0
const slug = () => `cust-${process.pid}-${++n}`.slice(0, 30)
const hostArgs = (over = {}) => submitArgs({ acr: null, authTime: null, sessionAt: null, token: null, reason: 'panel down: break-glass create (proof)', hostActor: 'deploy', ...over })

describe('A2: plt.submit_provisioning_request refuses', () => {
  // the time cases are built when the test RUNS (a table value is built at load time)
  it.each<[string, Parameters<typeof submitArgs>[0] | (() => Parameters<typeof submitArgs>[0]), string]>([
    ['acr loa1', { acr: 'loa1' }, '28000'],
    ['acr absent', { acr: null }, '28000'],
    ['NULL operator', { operator: null }, '22023'],
    ['sign-in 3601 s old', () => ({ authTime: new Date(Date.now() - 3601_000) }), '28000'],
    ['sign-in 61 s in the future', () => ({ authTime: new Date(Date.now() + 61_000) }), '28000'],
    ['panel session 3601 s old', () => ({ sessionAt: new Date(Date.now() - 3601_000) }), '28000'],
    ['no evidence token', { token: null }, '28000'],
    ['a 99-character token', { token: 'e'.repeat(99) }, '28000'],
    ['an invalid slug', { slug: '1-bad--slug' }, '22023'],
    ['slug platform', { slug: 'platform' }, '22023'],
    ['args an array', { args: ['x'] }, '22023'],
    ['args over 16 KiB', { args: { pad: 'x'.repeat(16_400) } }, '22023'],
    ['an unknown kind', { kind: 'drop_everything' }, '22023'],
    ['a reason from the panel role', { reason: 'I am the panel, trust me' }, '42501'],
    ['a host actor from the panel role', { hostActor: 'deploy' }, '42501'],
  ])('panel refuses: %s', async (what, over, sqlstate) => {
    const a = submitArgs(typeof over === 'function' ? over() : over)
    const f = await failure(submit(r.panel, a))
    quote(`panel ${what}`, f)
    expect(f?.code).toBe(sqlstate)
    expect(a.key ? await count(a.key) : 0).toBe(0)
  })

  it('a non-uuid operator never reaches the function body: 22P02 at the parameter cast', async () => {
    const f = await failure(submit(r.panel, submitArgs({ operator: 'root' })))
    quote('panel non-uuid operator', f)
    expect(f?.code).toBe('22P02')
  })

  it('host (executor) without a reason, with a short one, with a token or with a bad actor is refused', async () => {
    for (const [what, over] of [
      ['no reason', { reason: null }],
      ['a 9-character reason', { reason: 'too short' }],
      ['a token', { token: 'e'.repeat(300) }],
      ['a bad host actor', { hostActor: 'Root User' }],
    ] as const) {
      const a = hostArgs(over)
      const f = await failure(submit(r.executor, a))
      quote(`host ${what}`, f)
      expect(f?.code, what).toBe('22023')
      expect(await count(a.key!)).toBe(0)
    }
  })

  it('a third login role (the platform owner, and a role holding EXECUTE but no marker) is refused 42501', async () => {
    quote('third role (owner)', await failure(submit(r.owner, submitArgs())))
    expect((await failure(submit(r.owner, submitArgs())))?.code).toBe('42501')
    await r.admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't043d_stray') THEN CREATE ROLE t043d_stray LOGIN PASSWORD 't043d-stray-pw-not-a-secret'; END IF; END $$`)
    await r.admin.unsafe('GRANT CONNECT ON DATABASE gremion_platform TO t043d_stray')
    await r.owner.unsafe('GRANT USAGE ON SCHEMA plt TO t043d_stray')
    await r.owner.unsafe('GRANT EXECUTE ON FUNCTION plt.submit_provisioning_request(text, text, jsonb, uuid, uuid, text, timestamptz, timestamptz, text, text, text) TO t043d_stray')
    const stray = open('gremion_platform', 1, 't043d_stray', 't043d-stray-pw-not-a-secret')
    try {
      const f = await failure(submit(stray, submitArgs()))
      quote('third role (stray with EXECUTE)', f)
      expect(f?.code).toBe('42501')
    } finally {
      await stray.end()
      await r.owner.unsafe('REVOKE ALL ON FUNCTION plt.submit_provisioning_request(text, text, jsonb, uuid, uuid, text, timestamptz, timestamptz, text, text, text) FROM t043d_stray')
      await r.owner.unsafe('REVOKE USAGE ON SCHEMA plt FROM t043d_stray')
    }
  })
})

describe('A2: accepted requests and idempotency', () => {
  it('a valid panel request is origin=panel with its evidence; created_at is the server clock', async () => {
    const a = submitArgs({ slug: slug() })
    a.args = { slug: a.slug }
    const [{ id }] = (await submit(r.panel, a)) as unknown as [{ id: string }]
    const [row] = await r.owner<{ origin: string; acr: string; op: string; token: number; within: boolean }[]>`
      SELECT origin, evidence_acr AS acr, operator_id::text AS op, length(evidence_token) AS token,
             created_at - evidence_auth_time <= interval '3600 seconds' AS within
        FROM plt.provisioning_request WHERE request_id = ${id}::uuid`
    expect(row).toEqual({ origin: 'panel', acr: 'loa2', op: a.operator, token: 300, within: true })
  })

  it('a break-glass request is origin=host with reason and host actor', async () => {
    const a = hostArgs({ slug: slug() })
    const [{ id }] = (await submit(r.executor, a)) as unknown as [{ id: string }]
    const [row] = await r.owner<{ origin: string; reason: string; actor: string; token: string | null }[]>`
      SELECT origin, reason, host_actor AS actor, evidence_token AS token FROM plt.provisioning_request WHERE request_id = ${id}::uuid`
    expect(row).toEqual({ origin: 'host', reason: a.reason, actor: 'deploy', token: null })
  })

  it('the same key with the same content returns the same id and writes one row; with other content it is refused (23505)', async () => {
    const a = submitArgs({ slug: slug() })
    const [first] = (await submit(r.panel, a)) as unknown as [{ id: string }]
    const [second] = (await submit(r.panel, a)) as unknown as [{ id: string }]
    expect(second.id).toBe(first.id)
    expect(await count(a.key!)).toBe(1)
    const f = await failure(submit(r.panel, { ...a, args: { other: true } }))
    quote('same key, other content', f)
    expect(f?.code).toBe('23505')
    expect(await count(a.key!)).toBe(1)
  })
})

describe('TDD 4: immutability', () => {
  async function fresh(): Promise<string> {
    const [{ id }] = (await submit(r.panel, submitArgs({ slug: slug() }))) as unknown as [{ id: string }]
    return id
  }

  it('the owner cannot change args or operator_id; the token only clears, once', async () => {
    const id = await fresh()
    expect((await failure(r.owner`UPDATE plt.provisioning_request SET args = '{"x":1}' WHERE request_id = ${id}::uuid`))?.code).toBe('23514')
    expect((await failure(r.owner`UPDATE plt.provisioning_request SET operator_id = ${crypto.randomUUID()}::uuid WHERE request_id = ${id}::uuid`))?.code).toBe('23514')
    expect((await failure(r.owner`UPDATE plt.provisioning_request SET evidence_token = ${'f'.repeat(300)} WHERE request_id = ${id}::uuid`))?.code).toBe('23514')
    expect(await failure(r.owner`UPDATE plt.provisioning_request SET evidence_token = NULL WHERE request_id = ${id}::uuid`)).toBeNull()
    expect((await failure(r.owner`UPDATE plt.provisioning_request SET evidence_token = ${'f'.repeat(300)} WHERE request_id = ${id}::uuid`))?.code).toBe('23514')
  })

  it('a final request never moves (succeeded -> queued refused); DELETE and TRUNCATE are refused', async () => {
    const id = await fresh()
    await r.owner`UPDATE plt.provisioning_request SET state = 'running', claimed_by = 'h9', lease_until = now() + interval '1 minute' WHERE request_id = ${id}::uuid`
    await r.owner`UPDATE plt.provisioning_request SET state = 'succeeded', finished_at = now() WHERE request_id = ${id}::uuid`
    const back = await failure(r.owner`UPDATE plt.provisioning_request SET state = 'queued', finished_at = NULL WHERE request_id = ${id}::uuid`)
    console.log(`[TDD 4] succeeded -> queued: ${back?.code} ${back?.message}`)
    expect(back?.code).toBe('23514')
    expect((await failure(r.owner`DELETE FROM plt.provisioning_request WHERE request_id = ${id}::uuid`))?.code).toBe('23514')
    expect((await failure(r.owner`TRUNCATE plt.provisioning_request_event`))?.code).toBe('23514')
    expect((await failure(r.owner`TRUNCATE plt.provisioning_request CASCADE`))?.code).toBe('23514')
  })

  it('queued -> succeeded skips running: refused', async () => {
    const id = await fresh()
    expect((await failure(r.owner`UPDATE plt.provisioning_request SET state = 'succeeded', finished_at = now() WHERE request_id = ${id}::uuid`))?.code).toBe('23514')
  })
})

describe('TDD 5 / A6: claiming', () => {
  // Every claim test starts from an empty queue: whatever earlier tests left
  // queued is moved out of the way through the executor's own functions.
  async function drain(): Promise<void> {
    for (;;) {
      const got = await r.executor<{ request_id: string }[]>`SELECT request_id::text FROM plt.claim_provisioning_request('drain', 60)`
      if (!got.length) return
      await r.executor`SELECT plt.finish_provisioning_request(${got[0]!.request_id}::uuid, 'drain', 'refused', 'drained by the test')`
    }
  }
  const claim = (host: string, sql = r.executor) => sql<{ request_id: string; customer_slug: string; attempt: number }[]>`
    SELECT request_id::text, customer_slug, attempt FROM plt.claim_provisioning_request(${host}, 60)`
  const state = async (id: string) =>
    (await r.owner<{ state: string; attempt: number; claimed_by: string | null; outcome: string | null; token: boolean }[]>`
      SELECT state, attempt, claimed_by, outcome, evidence_token IS NOT NULL AS token FROM plt.provisioning_request WHERE request_id = ${id}::uuid`)[0]!

  it('none queued: nothing is claimed', async () => {
    await drain()
    expect(await claim(HOST)).toEqual([])
  })

  it('two connections claiming concurrently get distinct requests (or none)', async () => {
    await drain()
    const ids: string[] = []
    for (let i = 0; i < 2; i++) ids.push(((await submit(r.panel, submitArgs({ slug: slug() }))) as unknown as [{ id: string }])[0].id)
    // r.executor is a pool of two: the two claims run on two connections at once
    const [a, b] = await Promise.all([claim('h-a'), claim('h-b')])
    const got = [...a, ...b].map((x) => x.request_id)
    expect(new Set(got).size).toBe(got.length)
    expect(got.every((g) => ids.includes(g))).toBe(true)
    await drainRunning(got)
  })

  async function drainRunning(ids: string[]) {
    for (const id of ids) {
      const [row] = await r.owner<{ host: string }[]>`SELECT claimed_by AS host FROM plt.provisioning_request WHERE request_id = ${id}::uuid`
      await r.executor`SELECT plt.finish_provisioning_request(${id}::uuid, ${row!.host}, 'refused', 'test cleanup')`
    }
  }

  it('one request at a time per customer: the second for the same slug stays queued; a forced second running violates the index', async () => {
    await drain()
    const s = slug()
    const first = ((await submit(r.panel, submitArgs({ slug: s }))) as unknown as [{ id: string }])[0].id
    const second = ((await submit(r.panel, submitArgs({ slug: s }))) as unknown as [{ id: string }])[0].id
    expect((await claim(HOST)).map((x) => x.request_id)).toEqual([first])
    expect(await claim(HOST)).toEqual([])
    expect((await state(second)).state).toBe('queued')
    const forced = await failure(r.owner`UPDATE plt.provisioning_request SET state = 'running', claimed_by = 'h-x', lease_until = now() + interval '1 minute' WHERE request_id = ${second}::uuid`)
    console.log(`[A6] a forced second running for ${s}: ${forced?.code} ${forced?.message}`)
    expect(forced?.code).toBe('23505')
    await r.executor`SELECT plt.finish_provisioning_request(${first}::uuid, ${HOST}, 'succeeded', 'done')`
    expect((await claim(HOST)).map((x) => x.request_id)).toEqual([second])
    await drainRunning([second])
  })

  it('an expired lease re-queues with attempt + 1; the third expiry makes it dead with the reason', async () => {
    await drain()
    const id = ((await submit(r.panel, submitArgs({ slug: slug() }))) as unknown as [{ id: string }])[0].id
    expect((await claim(HOST)).map((x) => [x.request_id, x.attempt])).toEqual([[id, 0]])
    for (const want of [1, 2]) {
      await r.owner`UPDATE plt.provisioning_request SET lease_until = now() - interval '2 minutes' WHERE request_id = ${id}::uuid`
      // the claim first re-queues the expired one, then claims it again
      expect((await claim(HOST)).map((x) => [x.request_id, x.attempt])).toEqual([[id, want]])
    }
    await r.owner`UPDATE plt.provisioning_request SET lease_until = now() - interval '2 minutes' WHERE request_id = ${id}::uuid`
    expect(await claim(HOST)).toEqual([])
    const s = await state(id)
    console.log(`[A6] third expiry: ${s.state} attempt=${s.attempt} ${s.outcome}`)
    expect(s).toMatchObject({ state: 'dead', attempt: 3, token: false })
    expect(s.outcome).toMatch(/^dead: the lease expired on attempt 3 \(last claimed by h1\.example\)$/)
  })

  // H4 (create-harden): no two concurrent runs of one slug.
  it('H4: a live lease blocks every other host from the slug; a renewed lease stays blocked', async () => {
    await drain()
    const s = slug()
    const first = ((await submit(r.panel, submitArgs({ slug: s }))) as unknown as [{ id: string }])[0].id
    await submit(r.panel, submitArgs({ slug: s }))
    expect((await claim('host-a')).map((x) => x.request_id)).toEqual([first])
    expect(await claim('host-b')).toEqual([])
    await r.executor`SELECT plt.renew_provisioning_lease(${first}::uuid, 'host-a', 600)`
    expect(await claim('host-b')).toEqual([])
    expect(await state(first)).toMatchObject({ state: 'running', claimed_by: 'host-a', attempt: 0 })
    await drainRunning([first])
  })

  it('H4: a lease that just lapsed is NOT requeued (grace): the previous holder is still fenced by its own deadline, nobody can start attempt + 1', async () => {
    await drain()
    const s = slug()
    const id = ((await submit(r.panel, submitArgs({ slug: s }))) as unknown as [{ id: string }])[0].id
    await submit(r.panel, submitArgs({ slug: s }))
    expect((await claim('host-a')).map((x) => x.request_id)).toEqual([id])
    await r.owner`UPDATE plt.provisioning_request SET lease_until = now() - interval '1 second' WHERE request_id = ${id}::uuid`
    expect(await claim('host-b')).toEqual([])
    expect(await state(id)).toMatchObject({ state: 'running', claimed_by: 'host-a', attempt: 0 })
    await drainRunning([id])
  })

  it('H4: a lapsed lease cannot be revived by its holder; after the requeue the old holder is refused on every write', async () => {
    await drain()
    const id = ((await submit(r.panel, submitArgs({ slug: slug() }))) as unknown as [{ id: string }])[0].id
    expect((await claim('host-a')).length).toBe(1)
    await r.owner`UPDATE plt.provisioning_request SET lease_until = now() - interval '1 second' WHERE request_id = ${id}::uuid`
    expect((await failure(r.executor`SELECT plt.renew_provisioning_lease(${id}::uuid, 'host-a', 600)`))?.code).toBe('P0002')
    await r.owner`UPDATE plt.provisioning_request SET lease_until = now() - interval '2 minutes' WHERE request_id = ${id}::uuid`
    expect((await claim('host-b')).map((x) => [x.request_id, x.attempt])).toEqual([[id, 1]])
    for (const q of [
      r.executor`SELECT plt.renew_provisioning_lease(${id}::uuid, 'host-a', 600)`,
      r.executor`SELECT plt.record_provisioning_event(${id}::uuid, 'host-a', 'info', 'x', 'y')`,
      r.executor`SELECT plt.finish_provisioning_request(${id}::uuid, 'host-a', 'succeeded', 'x')`,
    ]) expect((await failure(q))?.code).toBe('P0002')
    await drainRunning([id])
  })

  it('requeue_own: at executor start its own running requests go back at once (attempt + 1), another host\'s stay', async () => {
    await drain()
    const mine = ((await submit(r.panel, submitArgs({ slug: slug() }))) as unknown as [{ id: string }])[0].id
    expect((await claim('h-own')).map((x) => x.request_id)).toEqual([mine])
    const theirs = ((await submit(r.panel, submitArgs({ slug: slug() }))) as unknown as [{ id: string }])[0].id
    expect((await claim('h-other')).map((x) => x.request_id)).toEqual([theirs])
    expect((await r.executor<{ n: number }[]>`SELECT plt.requeue_own_requests('h-own') AS n`)[0]!.n).toBe(1)
    expect(await state(mine)).toMatchObject({ state: 'queued', attempt: 1, claimed_by: null })
    expect(await state(theirs)).toMatchObject({ state: 'running', claimed_by: 'h-other' })
    await drainRunning([theirs])
  })

  it('a queued request never claimed within 30 minutes expires (and its token is cleared)', async () => {
    await drain()
    const key = crypto.randomUUID()
    await r.owner`
      INSERT INTO plt.provisioning_request (kind, customer_slug, args, idempotency_key, origin, operator_id, host_actor, reason, created_at)
      VALUES ('create', ${slug()}, '{}'::jsonb, ${key}::uuid, 'host', ${crypto.randomUUID()}::uuid, 'deploy', 'a request from before an outage', now() - interval '31 minutes')`
    expect(await claim(HOST)).toEqual([])
    const [row] = await r.owner<{ state: string; outcome: string }[]>`SELECT state, outcome FROM plt.provisioning_request WHERE idempotency_key = ${key}::uuid`
    expect(row).toEqual({ state: 'expired', outcome: 'expired: not claimed within 30 minutes of its submission' })
  })

  it('the executor functions refuse a request it does not hold, and the panel role cannot call them', async () => {
    await drain()
    const id = ((await submit(r.panel, submitArgs({ slug: slug() }))) as unknown as [{ id: string }])[0].id
    expect((await claim(HOST)).length).toBe(1)
    expect((await failure(r.executor`SELECT plt.finish_provisioning_request(${id}::uuid, 'h-not-me', 'succeeded', 'x')`))?.code).toBe('P0002')
    expect((await failure(r.executor`SELECT plt.record_provisioning_event(${id}::uuid, 'h-not-me', 'info', 'phase-a', 'x')`))?.code).toBe('P0002')
    expect((await failure(r.panel`SELECT plt.mark_provisioning_request_verified(${id}::uuid, ${HOST})`))?.code).toBe('42501')
    await r.executor`SELECT plt.record_provisioning_event(${id}::uuid, ${HOST}, 'info', 'verify', ${'y'.repeat(1500)})`
    await r.executor`SELECT plt.mark_provisioning_request_verified(${id}::uuid, ${HOST})`
    expect((await state(id)).token).toBe(false)
    await r.executor`SELECT plt.renew_provisioning_lease(${id}::uuid, ${HOST}, 600)`
    await r.executor`SELECT plt.finish_provisioning_request(${id}::uuid, ${HOST}, 'succeeded', 'ok')`
    const ev = await r.panel<{ len: number }[]>`SELECT length(message) AS len FROM plt.provisioning_request_event WHERE request_id = ${id}::uuid`
    expect(ev).toEqual([{ len: 1000 }])
    const hb = await r.executor<{ at: Date }[]>`SELECT plt.executor_beat(${HOST}, 'test-1') AS at`
    expect(hb[0]!.at).toBeInstanceOf(Date)
    expect((await r.panel<{ host: string }[]>`SELECT executor_host AS host FROM plt.executor_heartbeat`)[0]!.host).toBe(HOST)
  })
})
