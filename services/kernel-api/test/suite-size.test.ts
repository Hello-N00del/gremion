// TDD 16 -- the COLLECTED test count (vitest list, not a regex over the source)
// is at least the named total, per file and in sum. A test deleted to turn a
// red run green, a file whose describe stopped collecting, or a config that
// collects nothing, fails here although every remaining test passes.
// Mirrors packages/tenant-store/test/unit/suite-size.test.ts.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = fileURLToPath(new URL('../', import.meta.url))

/** The named tests per file, as of TASK-077 G8. Raise a floor when you add tests; never lower one. */
export const NAMED: Record<'unit' | 'integration' | 'authz' | 'live', Record<string, number>> = {
  unit: {
    'test/app/bundle-entry.test.ts': 2,
    // TASK-080-a round 3: the image's builder stage copies every workspace package the service reaches
    'test/app/dockerfile.test.ts': 2,
    'test/app/gate-rotation.test.ts': 4,
    'test/app/routes.test.ts': 11,
    // TASK-080-a house review: the relay and the HTTP path do not evict each other after a db_conn_ref change
    'test/app/tenant-db-relay.test.ts': 2,
    'test/app/trd082.test.ts': 5,
    // TASK-080-a: the bodies migrations as shipped
    'test/bodies/migrations.test.ts': 10,
    'test/bodies/cli.test.ts': 12,
    'test/bodies/http.test.ts': 13,
    'test/bodies/kinds.test.ts': 6,
    'test/outbox/catalogue.test.ts': 5,
    'test/outbox/compose.test.ts': 4,
    'test/outbox/relay-host.test.ts': 7,
    'test/conformance/conformance.test.ts': 14,
    'test/migrate/chain.test.ts': 9,
    'test/registry/registry.test.ts': 7,
    'test/tenancy/host.test.ts': 29,
    'test/tenancy/module-callers.test.ts': 12,
    'test/tenancy/target.test.ts': 13,
    'test/tenancy/tokens.test.ts': 15,
    'test/tenancy/token-outage.test.ts': 12,
    // G8 (static half): the audience mapper in the realm template
    'test/keycloak/realm-audience.test.ts': 4,
    // TASK-081
    'test/authz/catalogue.test.ts': 9,
    'test/authz/cli.test.ts': 6,
    'test/authz/sweep-interval.test.ts': 19,
    'test/authz/http.test.ts': 22,
    'test/authz/after-migrate.test.ts': 7,
    'test/authz/no-role-check.test.ts': 5,
    'test/authz/stepup.test.ts': 5,
    // TASK-081 G3: the PDP-backed WriteAuthorizer's table and its pre-database refusals
    'test/authz/write-authorizer.test.ts': 8,
    'test/authz/stepup-realm.test.ts': 2,
    'test/suite-size.test.ts': 5,
  },
  integration: {
    'test/app/kernel-api.int.test.ts': 17,
    // TASK-080-a round 3: the idt migrate hook steps run under the migration advisory lock
    'test/migrate/lock.int.test.ts': 4,
    // TASK-080-a round 3: TRD-082 for the domain service's own queries
    'test/bodies/scope.int.test.ts': 2,
    // TASK-080-a: the migrate hook and the identity domain service on the scratch PG18
    'test/bodies/hooks.int.test.ts': 7,
    'test/bodies/service.int.test.ts': 14,
    // TASK-080-a house review: database-level guards (acyclic race, immutable body_id, decided kinds, inbox pairs, TRUNCATE)
    'test/bodies/schema-guards.int.test.ts': 16,
    // G8 (live half): real Keycloak tokens carry / lack the audience
    'test/keycloak/audience.int.test.ts': 2,
    // 081 residual (r33-14 V7): a real Keycloak's step-up deny goes back to the app notice
    'test/keycloak/stepup-deny.int.test.ts': 2,
  },
  // TASK-081: its own scratch stack (test/authz/stack.mjs, vitest.authz-int.config.ts)
  authz: {
    'test/authz/after-migrate.int.test.ts': 1,
    'test/authz/grants.int.test.ts': 46,
    'test/authz/http.int.test.ts': 9,
    'test/authz/module-off.int.test.ts': 28,
    'test/authz/pdp.int.test.ts': 12,
    'test/authz/schema.int.test.ts': 8,
    'test/authz/write-authorizer.int.test.ts': 12,
  },
  // TASK-080-a test/bodies/proof.sh: PostgreSQL 18 + the authenticated NATS (vitest.live.config.ts)
  live: {
    'test/bodies/live.int.test.ts': 15,
  },
}

function collected(config: string): Record<string, number> {
  const r = spawnSync('pnpm', ['exec', 'vitest', 'list', '--config', config, '--no-staticParse', '--json'], {
    cwd: PKG,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  expect(r.status, r.stderr).toBe(0)
  const out: Record<string, number> = {}
  for (const t of JSON.parse(r.stdout) as { file: string }[]) {
    const f = t.file.split(sep).join('/').slice(PKG.split(sep).join('/').length)
    out[f] = (out[f] ?? 0) + 1
  }
  return out
}

export function assertFloor(got: Record<string, number>, named: Record<string, number>): void {
  const total = Object.values(got).reduce((a, b) => a + b, 0)
  if (total === 0) throw new Error('zero tests collected')
  const short = Object.entries(named).filter(([f, n]) => (got[f] ?? 0) < n).map(([f, n]) => `${f}: ${got[f] ?? 0} < ${n}`)
  if (short.length) throw new Error(`below the named floor: ${short.join('; ')}`)
  const sum = Object.values(named).reduce((a, b) => a + b, 0)
  if (total < sum) throw new Error(`collected ${total} < named total ${sum}`)
}

describe('suite size (TDD 16)', () => {
  it('the unit suite collects at least the named total', () => {
    expect(() => assertFloor(collected('vitest.config.ts'), NAMED.unit)).not.toThrow()
  }, 60_000)

  it('the integration suite collects at least the named total', () => {
    expect(() => assertFloor(collected('vitest.integration.config.ts'), NAMED.integration)).not.toThrow()
  }, 60_000)

  it('the authz integration suite collects at least the named total', () => {
    expect(() => assertFloor(collected('vitest.authz-int.config.ts'), NAMED.authz)).not.toThrow()
  }, 60_000)

  it('the live suite (proof.sh) collects at least the named total', () => {
    expect(() => assertFloor(collected('vitest.live.config.ts'), NAMED.live)).not.toThrow()
  }, 60_000)

  it('zero collected tests is a failure, and so is one missing test', () => {
    expect(() => assertFloor({}, { 'a.test.ts': 1 })).toThrow(/zero tests collected/)
    expect(() => assertFloor({ 'a.test.ts': 1 }, { 'a.test.ts': 2 })).toThrow(/a\.test\.ts: 1 < 2/)
  })

  it('no spec is skipped, todo or focused, and every spec on disk is named (vitest list collects those too)', () => {
    const specs: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(PKG, d), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'fixtures') continue
        const p = `${d}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.test.ts')) specs.push(p)
      }
    }
    walk('src')
    walk('test')
    expect(specs.length).toBeGreaterThanOrEqual(Object.keys(NAMED.unit).length + Object.keys(NAMED.integration).length + Object.keys(NAMED.authz).length + Object.keys(NAMED.live).length)
    const named = new Set([...Object.keys(NAMED.unit), ...Object.keys(NAMED.integration), ...Object.keys(NAMED.authz), ...Object.keys(NAMED.live)])
    expect(specs.filter((f) => !named.has(f))).toEqual([])
    const marked = specs.filter((f) => /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\b/.test(readFileSync(join(PKG, f), 'utf8')))
    expect(marked).toEqual([])
  })
})
