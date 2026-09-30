// TASK-043 TDD 12 (Q10): the fixture identities reconcile's narrowed
// no-fixture-users check refuses. Seed subjects are parsed from *_seed.sql,
// pad-agnostic; the shipped seeds are non-empty (the check is not vacuous).
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEV_SUPERUSER, fixtureUsernames, SEED_FILE, seedSubjectIds, seedSubjectIdsFrom } from './fixture-identities'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'migrations')
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

describe('seedSubjectIdsFrom', () => {
  it('reads both pad widths (005_dev_seed and 0005_dev_seed) and ignores a non-seed migration', () => {
    const ids = seedSubjectIdsFrom([
      { name: '005_dev_seed.sql', text: `INSERT INTO x VALUES ('${ID}')` },
      { name: '0005_dev_seed.sql', text: `INSERT INTO x VALUES ('${ID.toUpperCase()}')` },
      { name: '0011_org_units_dev_seed.sql', text: "INSERT INTO x VALUES ('11111111-2222-4333-8444-555555555555')" },
      { name: '0042_real_change.sql', text: "INSERT INTO x VALUES ('99999999-2222-4333-8444-555555555555')" },
    ])
    expect(ids).toEqual(['0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '11111111-2222-4333-8444-555555555555'])
  })

  it('SEED_FILE matches the shipped seed names and not a plain migration', () => {
    for (const n of ['0005_dev_seed.sql', '0006_full_seed.sql', '0011_org_units_dev_seed.sql', '005_dev_seed.sql']) expect(SEED_FILE.test(n)).toBe(true)
    for (const n of ['0001_init.sql', 'manifest.json', '0005_dev_seed.sql.bak']) expect(SEED_FILE.test(n)).toBe(false)
  })
})

describe('the shipped fixtures', () => {
  it('the kernel chain seeds name subject ids (the check is not vacuous)', () => {
    expect(seedSubjectIds(MIGRATIONS).length).toBeGreaterThan(10)
  })

  it('the template fixture usernames hold the dev superuser and the blueprint users', () => {
    const names = fixtureUsernames()
    expect(names).toContain(DEV_SUPERUSER)
    expect(names).toContain('anna.berger')
    expect(names.length).toBeGreaterThan(10)
  })
})
