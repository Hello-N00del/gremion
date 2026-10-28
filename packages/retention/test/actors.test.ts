// TRD-147 actor scan. RED recipes: seed a free-text actor; drop migration 0061.
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scanActorSchema, scanActorValues } from '../src/actors.ts'

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const DIR = join(ROOT, 'gremion-ui/migrations')
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8').replace(/\r\n/g, '\n') }))

describe('actor scan', () => {
  it('values: uuids pass, a seeded free-text actor and an address-like actor fail', () => {
    expect(scanActorValues('fixture', ['0192f3e0-1a2b-7c3d-8e4f-0123456789ab'])).toEqual([])
    expect(scanActorValues('fixture', ['calendar-service', 'newsletter-service'])).toEqual([])
    const bad = scanActorValues('fixture', ['Erika Mustermann', 'erika@example.org', 'U-OLD', 'erika-service@example.org', 'Erika-service'])
    expect(bad).toHaveLength(5)
    expect(bad.find((f) => f.value === '<address-like>')).toBeTruthy()
    expect(JSON.stringify(bad)).not.toContain('erika@example.org')
  })

  it('schema: the kernel-data chain carries the uuid CHECK on audit_log.user_id', () => {
    expect(scanActorSchema(MIGRATIONS)).toEqual([])
  })

  it('schema stays RED when the CHECK has any alternative beyond the uuid and the service principal', () => {
    const sql = MIGRATIONS.find((m) => m.name.startsWith('0061_'))!.sql
    const loose = sql.replace(/\)\s*NOT VALID;/, "  OR true ) NOT VALID;")
    expect(loose).not.toBe(sql)
    expect(scanActorSchema([{ name: '0061_x.sql', sql: loose }])).toHaveLength(1)
  })

  it('schema goes RED without migration 0061 (the free-text column)', () => {
    const without = MIGRATIONS.filter((m) => !m.name.startsWith('0061_'))
    expect(without.length).toBe(MIGRATIONS.length - 1)
    expect(scanActorSchema(without)).toHaveLength(1)
  })
})
