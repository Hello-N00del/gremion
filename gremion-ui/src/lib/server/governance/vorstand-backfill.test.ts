// vorstand-backfill.test.ts - Karenz phase 1, Task 8.
//
// drainRoleBackfill applies the queued `vorstand` realm role to the people the
// 0062 migration queued (the current members of the council's Vorstand
// committee). It is idempotent, bounded, and a single bad row never aborts the
// pass (Review Focus 6): a deleted Keycloak user is counted and closed, a Keycloak
// outage leaves the row for the next tick, and nothing is assigned to anybody who
// was not queued.
import { describe, expect, it } from 'vitest'
import { KcAdminError } from '$lib/server/keycloak-admin'
import { drainRoleBackfill, ROLE_BACKFILL_BATCH } from './vorstand-backfill'

interface Row {
  id: string
  role: string
  user_keycloak_id: string
  queued_at: number
  applied_at: number | null
  last_error: string | null
  attempts: number
}

/** An in-memory role_backfill table behind the tagged-template surface the drain uses. */
function fakeDb(seed: Array<Partial<Row> & { user_keycloak_id: string }>) {
  const rows: Row[] = seed.map((r, i) => ({
    id: r.id ?? `row-${i + 1}`,
    role: r.role ?? 'vorstand',
    user_keycloak_id: r.user_keycloak_id,
    queued_at: r.queued_at ?? i,
    applied_at: r.applied_at ?? null,
    last_error: r.last_error ?? null,
    attempts: r.attempts ?? 0,
  }))
  const statements: string[] = []
  const byId = (id: unknown) => rows.find((r) => r.id === id)
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim()
    statements.push(text)
    if (text.startsWith('SELECT id, role, user_keycloak_id FROM role_backfill')) {
      const limit = Number(values[0])
      const due = rows
        .filter((r) => r.applied_at === null)
        .sort((a, b) => a.attempts - b.attempts || a.queued_at - b.queued_at)
        .slice(0, limit)
      return Promise.resolve(due.map((r) => ({ id: r.id, role: r.role, user_keycloak_id: r.user_keycloak_id })))
    }
    if (text.includes('SET applied_at = now(), last_error = NULL')) {
      const r = byId(values[0])!
      r.applied_at = 1
      r.last_error = null
      r.attempts += 1
      return Promise.resolve([])
    }
    if (text.includes("SET applied_at = now(), last_error = 'user not found'")) {
      const r = byId(values[0])!
      r.applied_at = 1
      r.last_error = 'user not found'
      r.attempts += 1
      return Promise.resolve([])
    }
    if (text.includes('SET attempts = attempts + 1, last_error = ?')) {
      const r = byId(values[1])!
      r.attempts += 1
      r.last_error = String(values[0])
      return Promise.resolve([])
    }
    if (text.includes('SET last_error = ?')) {
      const r = byId(values[1])!
      r.last_error = String(values[0])
      return Promise.resolve([])
    }
    return Promise.reject(new Error(`fakeDb: unexpected statement: ${text}`))
  }
  return { sql: tag as never, rows, statements }
}

const VORSTAND = { id: 'role-1', name: 'vorstand' }

function fakeKc(over: {
  roles?: Array<{ id: string; name: string }>
  getUser?: (id: string) => Promise<unknown>
  assignRoles?: (id: string, roles: readonly unknown[]) => Promise<void>
  listThrows?: Error
} = {}) {
  const assigned: Array<{ userId: string; roles: string[] }> = []
  const kc = {
    listRealmRoles: async () => {
      if (over.listThrows) throw over.listThrows
      return over.roles ?? [VORSTAND]
    },
    getUser: over.getUser ?? (async (id: string) => ({ id })),
    assignRoles:
      over.assignRoles ??
      (async (userId: string, roles: readonly unknown[]) => {
        assigned.push({ userId, roles: (roles as Array<{ name: string }>).map((r) => r.name) })
      }),
  }
  return { kc: kc as never, assigned }
}

function fakeLog() {
  const errors: string[] = []
  const infos: string[] = []
  return {
    log: {
      info: (m: string) => void infos.push(m),
      error: (m: string, ...rest: unknown[]) => void errors.push([m, ...rest.map(String)].join(' ')),
    },
    errors,
    infos,
  }
}

describe('drainRoleBackfill', () => {
  it('assigns the vorstand role once and sets applied_at', async () => {
    const db = fakeDb([{ user_keycloak_id: 'u-1' }, { user_keycloak_id: 'u-2' }])
    const { kc, assigned } = fakeKc()
    const { log } = fakeLog()

    const out = await drainRoleBackfill(db.sql, kc, log)

    expect(out).toEqual({ applied: 2, failed: 0, gone: 0 })
    expect(assigned).toEqual([
      { userId: 'u-1', roles: ['vorstand'] },
      { userId: 'u-2', roles: ['vorstand'] },
    ])
    expect(db.rows.every((r) => r.applied_at !== null && r.last_error === null)).toBe(true)
  })

  it('a second drain assigns nothing', async () => {
    const db = fakeDb([{ user_keycloak_id: 'u-1' }])
    const { kc, assigned } = fakeKc()
    const { log } = fakeLog()
    await drainRoleBackfill(db.sql, kc, log)
    assigned.length = 0

    const out = await drainRoleBackfill(db.sql, kc, log)

    expect(out).toEqual({ applied: 0, failed: 0, gone: 0 })
    expect(assigned).toEqual([])
  })

  it('does not call Keycloak at all when nothing is queued', async () => {
    const db = fakeDb([])
    let calls = 0
    const kc = {
      listRealmRoles: async () => (calls++, []),
      getUser: async () => (calls++, {}),
      assignRoles: async () => void calls++,
    }
    const out = await drainRoleBackfill(db.sql, kc as never, fakeLog().log)
    expect(out).toEqual({ applied: 0, failed: 0, gone: 0 })
    expect(calls).toBe(0)
  })

  it('a 404 user is counted gone, closed with a reason and not retried', async () => {
    const db = fakeDb([{ user_keycloak_id: 'deleted-user' }, { user_keycloak_id: 'u-2' }])
    const { kc, assigned } = fakeKc({
      getUser: async (id) => {
        // the real client turns a 404 into this sentinel
        if (id === 'deleted-user') throw new Error('User not found')
        return { id }
      },
    })
    const { log } = fakeLog()

    const out = await drainRoleBackfill(db.sql, kc, log)

    expect(out).toEqual({ applied: 1, failed: 0, gone: 1 })
    expect(assigned.map((a) => a.userId)).toEqual(['u-2'])
    const gone = db.rows.find((r) => r.user_keycloak_id === 'deleted-user')!
    expect(gone.applied_at).not.toBeNull()
    expect(gone.last_error).toBe('user not found')

    // not retried: a second pass finds nothing pending
    expect(await drainRoleBackfill(db.sql, kc, log)).toEqual({ applied: 0, failed: 0, gone: 0 })
  })

  it('a user that vanishes between the lookup and the assignment (404 on assign) is gone too', async () => {
    const db = fakeDb([{ user_keycloak_id: 'u-1' }])
    const { kc } = fakeKc({
      assignRoles: async () => {
        throw new KcAdminError(404, 'User not found')
      },
    })
    const out = await drainRoleBackfill(db.sql, kc, fakeLog().log)
    expect(out).toEqual({ applied: 0, failed: 0, gone: 1 })
    expect(db.rows[0]!.applied_at).not.toBeNull()
  })

  it('a 5xx leaves applied_at null, increments attempts, logs loudly and keeps going with the next row', async () => {
    const db = fakeDb([{ user_keycloak_id: 'u-bad' }, { user_keycloak_id: 'u-ok' }])
    const seen: string[] = []
    const { kc } = fakeKc({
      assignRoles: async (id) => {
        if (id === 'u-bad') throw new KcAdminError(503, 'upstream unavailable')
        seen.push(id)
      },
    })
    const { log, errors } = fakeLog()

    const out = await drainRoleBackfill(db.sql, kc, log)

    expect(out).toEqual({ applied: 1, failed: 1, gone: 0 })
    const bad = db.rows.find((r) => r.user_keycloak_id === 'u-bad')!
    expect(bad.applied_at).toBeNull()
    expect(bad.attempts).toBe(1)
    expect(bad.last_error).toContain('503')
    expect(seen).toEqual(['u-ok'])
    expect(errors.some((e) => e.includes('u-bad'))).toBe(true)

    // retried on the next tick, and a recovered Keycloak closes it
    const { kc: healed, assigned: after } = fakeKc()
    expect(await drainRoleBackfill(db.sql, healed, log)).toEqual({ applied: 1, failed: 0, gone: 0 })
    expect(after.map((a) => a.userId)).toEqual(['u-bad'])
  })

  it('a row that keeps failing does not starve fresh rows past the batch limit', async () => {
    const poison = Array.from({ length: ROLE_BACKFILL_BATCH }, (_, i) => ({
      user_keycloak_id: `poison-${i}`,
      attempts: 5,
    }))
    const db = fakeDb([...poison, { user_keycloak_id: 'fresh', queued_at: 9999 }])
    const { kc, assigned } = fakeKc()
    await drainRoleBackfill(db.sql, kc, fakeLog().log)
    expect(assigned.some((a) => a.userId === 'fresh')).toBe(true)
  })

  it('it refuses to run when the realm has no vorstand role (failed = pending count, logs the reconcile hint)', async () => {
    const db = fakeDb([{ user_keycloak_id: 'u-1' }, { user_keycloak_id: 'u-2' }])
    const { kc, assigned } = fakeKc({ roles: [{ id: 'r', name: 'council-admin' }] })
    const { log, errors } = fakeLog()

    const out = await drainRoleBackfill(db.sql, kc, log)

    expect(out).toEqual({ applied: 0, failed: 2, gone: 0 })
    expect(assigned).toEqual([])
    expect(db.rows.every((r) => r.applied_at === null)).toBe(true)
    expect(errors.join('\n')).toContain('vorstand-role')
  })

  it('a Keycloak outage while listing the realm roles fails the pass without throwing', async () => {
    const db = fakeDb([{ user_keycloak_id: 'u-1' }])
    const { kc } = fakeKc({ listThrows: new KcAdminError(500, 'boom') })
    const { log, errors } = fakeLog()
    await expect(drainRoleBackfill(db.sql, kc, log)).resolves.toEqual({ applied: 0, failed: 1, gone: 0 })
    expect(errors.length).toBeGreaterThan(0)
    expect(db.rows[0]!.applied_at).toBeNull()
  })
})
