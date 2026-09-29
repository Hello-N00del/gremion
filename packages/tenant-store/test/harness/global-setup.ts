// packages/tenant-store/test/harness/global-setup.ts
//
// The two-tenant scratch stack: on the one server, `control` (the kernel's
// control-plane migrations, applied BY THIS PACKAGE'S RUNNER), two tenants
// registered there with their DEFAULT ids (uuidv7(), TASK-019), and one
// database per tenant for the fixture module: t_<A>__fixture, t_<B>__fixture.
// Creating those databases is test-harness work on a scratch server; the
// package itself never creates or drops a database (TASK-021 owns that).
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'
import { migratePlatform } from '../../src/lifecycle/platform.js'
import { runMigrations } from '../../src/runner.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connect } from './db.js'

export const CONTROL_MIGRATIONS = fileURLToPath(new URL('../../../../gremion-ui/migrations-control/', import.meta.url))

declare module 'vitest' {
  export interface ProvidedContext {
    tenants: { A: string; B: string }
  }
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    const sql = connect(process.env.T020_ADMIN_DB ?? 't020_test_admin', { max: 1, connect_timeout: 2 })
    try {
      await sql`SELECT 1`
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    } finally {
      await sql.end()
    }
  }
  throw new Error('scratch server not ready')
}

export default async function setup(project: TestProject) {
  // `vitest list` (the suite-size floor, TDD 10) collects without a stack:
  // placeholder ids, and no database is touched.
  if (process.env.T020_COLLECT_ONLY === '1') {
    project.provide('tenants', { A: '00000000-0000-7000-8000-000000000001', B: '00000000-0000-7000-8000-000000000002' })
    return
  }
  await waitReady()
  const admin = connect('t020_test_admin', { max: 1 })
  try {
    await admin.unsafe('DROP DATABASE IF EXISTS control WITH (FORCE)')
    await admin.unsafe('CREATE DATABASE control')
    const control = connect('control', { max: 2 })
    try {
      await runMigrations({ sql: control, dir: CONTROL_MIGRATIONS })
      const ids: string[] = []
      for (const slug of ['t020-a', 't020-b']) {
        const [row] = await control<{ id: string }[]>`
          INSERT INTO tenant (slug, status, db_conn_ref, realm_name, issuer, kc_internal, kc_client_id,
            kc_client_ref, auth_client_ref, nc_target, matrix_space, domain_profile, brand_ref,
            blueprint_ref, conn_profile, backup_key_ref, audiences)
          VALUES (${slug}, 'active', 'ref', ${slug}, ${'https://idp.invalid/' + slug}, 'x', 'gremion-admin',
            'ref', 'ref', '{}', '{}', '{}', 'ref', 'ref', '{}', 'ref', '{}')
          RETURNING id`
        ids.push(row!.id)
      }
      const [A, B] = ids as [string, string]
      for (const t of [A, B]) {
        const name = tenantModuleDbName(t, 'fixture')
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        await admin.unsafe(`CREATE DATABASE ${name}`)
        // TASK-021 Q6: each customer's kernel database, created by the harness
        // here (by TASK-043 for real), so the TRD-089 inspection has one.
        const kernel = tenantModuleDbName(t, 'kernel')
        await admin.unsafe(`DROP DATABASE IF EXISTS ${kernel} WITH (FORCE)`)
        await admin.unsafe(`CREATE DATABASE ${kernel}`)
      }
      // TASK-021 Q2: the platform catalogue, created by the harness (at
      // installation by TASK-043/TASK-077 for real), migrated by the one runner.
      await admin.unsafe('DROP DATABASE IF EXISTS gremion_platform WITH (FORCE)')
      await admin.unsafe('CREATE DATABASE gremion_platform')
      const platform = connect('gremion_platform', { max: 2 })
      try {
        await migratePlatform(platform, { log: () => {} })
      } finally {
        await platform.end()
      }
      project.provide('tenants', { A, B })
    } finally {
      await control.end()
    }
  } finally {
    await admin.end()
  }
}
