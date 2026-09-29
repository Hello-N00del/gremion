// packages/tenant-store/test/fixtures/boot.ts
//
// TASK-029: the fixture service as a PROCESS, so the boot refusal is observed
// the way an orchestrator sees it: exit code, stderr, and whether anything
// listened. Prints `listening <port>` once it serves; on a failed
// verification prints the refusal to stderr and exits 1 before listening.
// T029_DIR = the module's migrations directory; T029_TENANTS = comma list.
import { envResolveTarget } from '../../src/names.js'
import { schemaGate } from '../../src/schema-gate.js'
import { createTenantStore } from '../../src/store.js'
import { assertNonProductionDbUrl, serverUrl } from '../harness/db.js'
import { bootFixtureService } from './service.js'

const dir = process.env.T029_DIR!
const tenants = new Set((process.env.T029_TENANTS ?? '').split(',').filter(Boolean))

const env = envResolveTarget({ GREMION_FIXTURE_PG_URL: serverUrl() })
const store = createTenantStore({
  resolveTarget: (t, m) => {
    const target = env(t, m)
    assertNonProductionDbUrl(target.url)
    return target
  },
})

try {
  const gate = schemaGate({ dir, openDb: (t) => store.openTenantDb(t, 'fixture'), cacheTtlMs: 0, log: () => {} })
  const { port } = await bootFixtureService({ store, gate, tenants, dir })
  process.stdout.write(`listening ${port}\n`)
  process.on('SIGTERM', () => {
    void store.close().finally(() => process.exit(0))
  })
} catch (err) {
  process.stderr.write(`[fixture-service] ${(err as Error).message}\n`)
  await store.close()
  process.exit(1)
}
