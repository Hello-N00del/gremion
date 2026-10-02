// TASK-042 TDD 5 (Q1; PRD-IDN-005 [D R18-1], OWASP Top 10 2021 A01/A05): the
// first-run setup wizard, its API and its never-expiring, log-printed setup
// token are gone. The first administrator of a tenant is created by the platform
// operator (TASK-043), never by whoever reaches a fresh host first. The routes
// that must not exist are asserted by path, so a revert that restores any one of
// them fails here, and the adapter manifest check in the running-stack proof
// (test/host/integration/zero-tenant-proof.sh) covers the built image.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const UI = resolve(import.meta.dirname, '../../../..')

describe('the first-run setup wizard is gone (TASK-042 Q1)', () => {
  it('there is no routes/setup/** page tree', () => {
    expect(existsSync(resolve(UI, 'src/routes/setup'))).toBe(false)
  })

  it.each(['admins', 'config', 'health'])('there is no api/setup/%s route', (name) => {
    expect(existsSync(resolve(UI, 'src/routes/api/setup', name))).toBe(false)
  })

  it('the only api/setup routes left are seed and test-smtp', () => {
    const dirs = readdirSync(resolve(UI, 'src/routes/api/setup'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    expect(dirs).toEqual(['seed', 'test-smtp'])
  })

  it.each([
    'src/routes/api/setup/setup-api.test.ts',
    'src/lib/server/setup-token.ts',
    'src/lib/server/setup-token.test.ts',
    'src/lib/server/setup-readiness.ts',
    'src/lib/server/setup-readiness.test.ts',
  ])('%s is deleted', (rel) => {
    expect(existsSync(resolve(UI, rel))).toBe(false)
  })
})
