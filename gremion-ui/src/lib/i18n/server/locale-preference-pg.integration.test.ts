// TASK-062 TDD 4 — the LocalePreferencePort contract against Postgres: the pg
// reference adapter on the verbatim DB-IDT-PREFERENCE / DB-IDT-CUSTOMERSETTING
// DDL (testing/idt-preference.fixture.sql), with RLS enforced.
//
// Runs under `pnpm test:integration` (DATABASE_URL, a local test server; the
// config's assertSafeTestDbUrl guard applies). The suite never touches that
// database's tables: it creates its own throwaway database next to it, applies
// the fixture there, and drops it afterwards. The adapter connects as a
// NOLOGIN, non-superuser role (a superuser would bypass RLS), selected with
// the `role` startup parameter, so the RLS assertion is real.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { createLocalePreferencePort } from './locale-preference-port'
import { CONTRACT_IDS, describeLocalePreferenceContract } from './testing/locale-preference-contract'

const ADMIN_URL = process.env.DATABASE_URL
if (!ADMIN_URL) throw new Error('DATABASE_URL is required for the locale-preference pg contract suite')

const DB_NAME = `locale_pref_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
const APP_ROLE = 'gremion_locale_pref_test'
const FIXTURE = readFileSync(join(__dirname, 'testing', 'idt-preference.fixture.sql'), 'utf8')

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL!)
  url.pathname = `/${database}`
  return url.toString()
}

const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} })
let owner: postgres.Sql
let app: postgres.Sql

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${DB_NAME}`)
  owner = postgres(urlFor(DB_NAME), { max: 1, onnotice: () => {} })
  await owner.unsafe(FIXTURE)
  await owner.unsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`)
  await owner.unsafe(`GRANT USAGE ON SCHEMA idt TO ${APP_ROLE};
    GRANT SELECT, INSERT, UPDATE ON idt.preference, idt.customer_setting TO ${APP_ROLE};`)
  // Seeded by the owner (superuser, so RLS does not apply to the seed).
  await owner`INSERT INTO idt.person (person_id) VALUES (${CONTRACT_IDS.person1})`
  await owner`INSERT INTO idt.customer_setting (customer_id, default_locale, time_zone, created_by_kind, updated_by_kind)
              VALUES (${CONTRACT_IDS.customerA}, 'en', 'Europe/Berlin', 'system', 'system'),
                     (${CONTRACT_IDS.customerB}, 'de', 'Europe/Berlin', 'system', 'system')`
  app = postgres(urlFor(DB_NAME), { max: 2, onnotice: () => {}, connection: { role: APP_ROLE } })
}, 60_000)

afterAll(async () => {
  await app?.end()
  await owner?.end()
  await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`)
  await admin.end()
}, 60_000)

describe('pg harness sanity', () => {
  it('the adapter connection is the non-superuser role, so RLS applies to it', async () => {
    const [who] = await app<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`
    expect(who).toEqual({ current_user: APP_ROLE, rolsuper: false, rolbypassrls: false })
  })

  it('without set_config(gremion.customer_id) the role sees no preference rows at all', async () => {
    await owner`INSERT INTO idt.preference (person_id, customer_id, locale, created_by_kind, updated_by_kind)
                VALUES (${CONTRACT_IDS.person1}, ${CONTRACT_IDS.customerA}, 'en', 'system', 'system')`
    expect(await app`SELECT person_id FROM idt.preference`).toHaveLength(0)
    await owner`TRUNCATE idt.preference`
  })
})

describeLocalePreferenceContract('pg', {
  fresh: async () => {
    await owner`TRUNCATE idt.preference`
    return createLocalePreferencePort({ backend: 'pg', sql: app })
  }
})

describe('pg adapter specifics', () => {
  it('the upsert leaves the SCHEMA columns consistent: created_by=person on insert, updated_at moves on update', async () => {
    await owner`TRUNCATE idt.preference`
    const port = createLocalePreferencePort({ backend: 'pg', sql: app })
    await port.set(CONTRACT_IDS.customerA, CONTRACT_IDS.person1, 'en')
    const [first] = await owner`SELECT created_by_kind, created_by, updated_at, customer_id FROM idt.preference`
    await port.set(CONTRACT_IDS.customerA, CONTRACT_IDS.person1, 'de')
    const [second] = await owner`SELECT created_by_kind, created_by, updated_at, row_version FROM idt.preference`
    expect(first).toMatchObject({ created_by_kind: 'person', created_by: CONTRACT_IDS.person1, customer_id: CONTRACT_IDS.customerA })
    expect(second!.created_by).toBe(CONTRACT_IDS.person1)
    expect(Number(second!.row_version)).toBe(2)
    expect((second!.updated_at as Date).getTime()).toBeGreaterThanOrEqual((first!.updated_at as Date).getTime())
  })

  it('a write under another customer for an existing person is refused by RLS, not silently applied', async () => {
    await owner`TRUNCATE idt.preference`
    const port = createLocalePreferencePort({ backend: 'pg', sql: app })
    await port.set(CONTRACT_IDS.customerA, CONTRACT_IDS.person1, 'en')
    await expect(port.set(CONTRACT_IDS.customerB, CONTRACT_IDS.person1, 'de')).rejects.toThrow()
    expect(await port.get(CONTRACT_IDS.customerA, CONTRACT_IDS.person1)).toMatchObject({ locale: 'en', rowVersion: 1 })
  })
})
