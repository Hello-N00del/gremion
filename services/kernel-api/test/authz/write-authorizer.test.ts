// TASK-081 G3, the part that needs no database: the PDP-backed WriteAuthorizer's
// table is the identity domain service's operation list (no operation is left
// unnamed, none is named that the service never asks), every capability it maps to
// is a kernel (module-less) capability some role carries, and the refusals that
// precede any database read (an operator actor, an unknown operation) are default
// deny.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readConfig } from '../../src/app/config.ts'
import { wireDeps } from '../../src/app/wire.ts'
import { KERNEL_API_MIGRATION_DIRS } from '../../src/migrate/chain.ts'
import { capabilityDef, ROLES } from '../../src/authz/catalogue.ts'
import { AUTHORIZED_WRITE_OPERATIONS, pdpWriteAuthorizer } from '../../src/authz/write-authorizer.ts'
import type { Sql } from '../../src/authz/tx.ts'

const BODIES = fileURLToPath(new URL('../../src/bodies/', import.meta.url))
// callable (the authorizer now runs queries on a transaction handle), and any use of it is a read
const NO_DB = new Proxy(() => undefined, { get: () => { throw new Error('the authorizer read the database') }, apply: () => { throw new Error('the authorizer read the database') } }) as unknown as Sql
const ENABLED = async () => new Set<string>()
const req = (over: Record<string, unknown>) => ({ actor: { kind: 'person' as const, id: '0192f0c1-2b3c-7d4e-8f00-000000000001' }, customerId: '0192f0c1-2b3c-7d4e-8f00-000000000002', operation: 'orgunit.create', bodyId: null, sql: NO_DB, ...over }) as never

describe('the PDP write authorizer (no database)', () => {
  it('names exactly the operations the domain service asks about (nothing unnamed, nothing stale)', () => {
    const asked = new Set<string>()
    for (const f of readdirSync(BODIES).filter((n) => n.endsWith('.ts'))) {
      for (const m of readFileSync(join(BODIES, f), 'utf8').matchAll(/\.allow\(\s*ctx\s*,\s*tx\s*,\s*'([a-z.]+)'/g)) asked.add(m[1]!)
    }
    expect(asked.size).toBeGreaterThanOrEqual(20)
    expect([...AUTHORIZED_WRITE_OPERATIONS].sort()).toEqual([...asked].sort())
  })

  it('every capability it maps to is a kernel capability (no module test) that at least one role carries', () => {
    for (const key of ['idt.structure.manage', 'idt.membership.manage', 'idt.person.manage']) {
      expect(capabilityDef(key)?.moduleKey, key).toBeNull()
      expect(ROLES.some((r) => r.capabilities.includes(key)), key).toBe(true)
    }
  })

  it('an operator or system actor is refused before any read (the PDP never speaks for them)', async () => {
    const a = pdpWriteAuthorizer(ENABLED)
    expect(await a.authorize(req({ actor: { kind: 'operator', id: '0192f0c1-2b3c-7d4e-8f00-000000000003' } }))).toBe(false)
    expect(await a.authorize(req({ actor: { kind: 'system', id: null } }))).toBe(false)
  })

  it('an operation without a capability row is refused before any read, including prototype names', async () => {
    const a = pdpWriteAuthorizer(ENABLED)
    for (const operation of ['orgunit.delete', 'preference.put', 'constructor', '__proto__', '']) expect(await a.authorize(req({ operation })), operation).toBe(false)
  })

  it('wireDeps binds it: the served authorizer asks the database for a person (denyAll would answer false without reading)', async () => {
    const KERNEL_ROOT = join(BODIES, '..', '..', '..', '..')
    const config = readConfig(
      { TENANT_PROXY_SHARED_SECRET: 'x'.repeat(32), PLATFORM_DOMAIN: 'example.org', KERNEL_API_CONTROL_DB_URL: 'postgres://u:p@127.0.0.1:1/c', KERNEL_API_PLATFORM_DB_URL: 'postgres://u:p@127.0.0.1:1/p' },
      { modulesRoot: join(KERNEL_ROOT, 'modules'), kernelRoot: KERNEL_ROOT },
    )
    const dirs = KERNEL_API_MIGRATION_DIRS.map((d) => join(BODIES, '..', '..', d))
    const wired = wireDeps(config, { dirs, log: { info: () => {}, warn: () => {}, error: () => {} } })
    try {
      await expect(wired.deps.authorizer.authorize(req({ operation: 'orgunit.create', bodyId: '0192f0c1-2b3c-7d4e-8f00-000000000004' }))).rejects.toThrow(/read the database/)
    } finally {
      await wired.close()
    }
  })
})
