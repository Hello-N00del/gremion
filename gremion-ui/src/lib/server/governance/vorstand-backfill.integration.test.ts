// Vorstand backfill (Karenz phase 1, Task 8): migration 0062 queues the current members
// of a committee named (or labelled) Vorstand into role_backfill. Runs against the
// migrated integration database (pnpm test:integration).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { getDb } from '$lib/server/db'
import { drainRoleBackfill } from './vorstand-backfill'

const MIGRATION = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'migrations', '0062_vorstand_role_backfill.sql',
)

/** Run the migration file's SQL again (it must be re-runnable) inside one transaction, as the runner does. */
async function runMigration(): Promise<void> {
  const sql = readFileSync(MIGRATION, 'utf8')
  await getDb().begin(async (tx) => {
    await tx.unsafe(sql)
  })
}

async function unit(name: string, kind: string, kindLabel: string | null): Promise<string> {
  const rows = await getDb()<{ id: string }[]>`
    INSERT INTO org_units (name, kind, kind_label)
    VALUES (${name}, ${kind}, ${kindLabel})
    RETURNING id`
  return rows[0]!.id
}

async function member(orgUnitId: string, userId: string, termEnd: string | null = null): Promise<void> {
  await getDb()`
    INSERT INTO org_unit_members (org_unit_id, user_keycloak_id, term_end)
    VALUES (${orgUnitId}, ${userId}, ${termEnd})`
}

async function queued(): Promise<string[]> {
  const rows = await getDb()<{ user_keycloak_id: string }[]>`
    SELECT user_keycloak_id FROM role_backfill ORDER BY user_keycloak_id`
  return rows.map((r) => r.user_keycloak_id)
}

beforeEach(async () => {
  const sql = getDb()
  await sql`TRUNCATE role_backfill`
  await sql`DELETE FROM org_unit_members`
  await sql`DELETE FROM committee_elections`
  await sql`DELETE FROM org_units`
})

describe('0062 vorstand role backfill', () => {
  it('queues the members of a committee named Vorstand and of one labelled Vorstand, skips expired terms and other committees, and is re-runnable', async () => {
    const named = await unit('Vorstand', 'committee', null)
    const labelled = await unit('Leitung', 'committee', 'Vorstand')
    const other = await unit('Haushaltsausschuss', 'committee', null)
    // A group named Vorstand is not the committee the role replaces.
    const wrongKind = await unit('Vorstand', 'group', null)

    await member(named, 'u-named-1')
    await member(named, 'u-named-2', '2999-01-01') // term still running
    await member(named, 'u-expired', '2000-01-01') // term over
    await member(labelled, 'u-labelled')
    await member(labelled, 'u-named-1') // sits on both: queued once
    await member(other, 'u-other')
    await member(wrongKind, 'u-group')

    await runMigration()

    expect(await queued()).toEqual(['u-labelled', 'u-named-1', 'u-named-2'])
    const rows = await getDb()<{ role: string; source: string; applied_at: Date | null; attempts: number }[]>`
      SELECT role, source, applied_at, attempts FROM role_backfill`
    expect(rows.every((r) => r.role === 'vorstand' && r.source === 'committee-name:Vorstand')).toBe(true)
    expect(rows.every((r) => r.applied_at === null && r.attempts === 0)).toBe(true)

    // Re-run: nothing new, and an applied row keeps its mark.
    await getDb()`UPDATE role_backfill SET applied_at = now() WHERE user_keycloak_id = 'u-labelled'`
    await runMigration()
    expect(await queued()).toEqual(['u-labelled', 'u-named-1', 'u-named-2'])
    const kept = await getDb()<{ applied_at: Date | null }[]>`
      SELECT applied_at FROM role_backfill WHERE user_keycloak_id = 'u-labelled'`
    expect(kept[0]!.applied_at).not.toBeNull()
  })

  it('queues nobody on a council with no Vorstand committee', async () => {
    const other = await unit('Kassenpruefung', 'committee', null)
    await member(other, 'u-1')
    await runMigration()
    expect(await queued()).toEqual([])
  })

  it('drainRoleBackfill closes the queued rows against the real table', async () => {
    const named = await unit('Vorstand', 'committee', null)
    await member(named, 'u-ok')
    await member(named, 'u-deleted')
    await runMigration()

    const assigned: string[] = []
    const out = await drainRoleBackfill(
      getDb(),
      {
        listRealmRoles: async () => [{ id: 'r1', name: 'vorstand' }],
        getUser: async (id: string) => {
          if (id === 'u-deleted') throw new Error('User not found')
          return { id } as never
        },
        assignRoles: async (id: string) => void assigned.push(id),
      },
      { info: () => {}, error: () => {} },
    )

    expect(out).toEqual({ applied: 1, failed: 0, gone: 1 })
    expect(assigned).toEqual(['u-ok'])
    const rows = await getDb()<{ user_keycloak_id: string; applied_at: Date | null; last_error: string | null }[]>`
      SELECT user_keycloak_id, applied_at, last_error FROM role_backfill ORDER BY user_keycloak_id`
    expect(rows.map((r) => [r.user_keycloak_id, r.applied_at !== null, r.last_error])).toEqual([
      ['u-deleted', true, 'user not found'],
      ['u-ok', true, null],
    ])
    // Nothing is left pending.
    expect(await drainRoleBackfill(getDb(), { listRealmRoles: async () => [], getUser: async () => ({}) as never, assignRoles: async () => {} }, { info: () => {}, error: () => {} })).toEqual({ applied: 0, failed: 0, gone: 0 })
  })
})
