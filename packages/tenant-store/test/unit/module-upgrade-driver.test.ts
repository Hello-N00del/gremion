// CD module step: the connection-level classification against the REAL driver's errors (postgres.js), not
// only against hand-made error objects (module-upgrade.test.ts): a port nothing listens on and a server that
// accepts the TCP connection and never answers the startup message. Both happen on the first query to a database,
// before any DDL, so both must come out as `connection` (exit 3 of the verb), carrying the driver's own code.
import { createServer, type Server, type Socket } from 'node:net'
import postgres from 'postgres'
import { afterEach, describe, expect, it } from 'vitest'
import { upgradeModuleDatabases } from '../../src/lifecycle/upgrade.js'
import { tenantModuleDbName } from '../../src/names.js'
import type { LifecycleModule } from '../../src/lifecycle/types.js'

const C1 = '0192f0c1-2b3c-7d4e-8f00-000000000001'
const MODULE: LifecycleModule = {
  id: 'zzdriver',
  dir: '/nonexistent',
  moduleJson: {
    schemaVersion: 1,
    id: 'zzdriver',
    extractionSource: 'f276af5925abacdcfd05f6613fc11afff2d804c5',
    runtime: { version: '1.0.0', database: { postgresService: 'zzdriver-postgres', migrations: 'migrations' }, export: null, timedJobs: [], platformServer: null },
  } as LifecycleModule['moduleJson'],
}

const platform = (): never => {
  const rows = [{ customer_id: C1, module_key: 'zzdriver', db_name: tenantModuleDbName(C1, 'zzdriver'), state: 'enabled', enablement_state: 'enabled' }]
  return ((strings: TemplateStringsArray) => Promise.resolve(/current_database\(\)/.test(strings.join('?')) ? [{ db: 'gremion_platform' }] : rows)) as never
}

const sockets = new Set<Socket>()
let silent: Server | undefined
afterEach(async () => {
  for (const s of sockets) s.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => (silent ? silent.close(() => resolve()) : resolve()))
  silent = undefined
})

async function run(admin: postgres.Sql) {
  try {
    return await upgradeModuleDatabases({
      platform: platform(),
      catalogue: [MODULE],
      releaseRef: 'dist-v0.0.1',
      server: () => ({ admin: admin as never, open: () => Promise.reject(new Error('never opened')) }),
    })
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {})
  }
}

describe('connection-level failures of the real driver, before any DDL', () => {
  it('a refused connection (ECONNREFUSED) is a connection failure', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port
        s.close(() => resolve(p))
      })
    })
    const r = await run(postgres(`postgres://u:p@127.0.0.1:${port}/x`, { max: 1, connect_timeout: 5, onnotice: () => {} }))
    expect(r).toMatchObject({ total: 1, failed: 1, failure: { kind: 'connection', code: 'connection_ECONNREFUSED', ordinal: 1 } })
  })

  it('a connect that never completes (CONNECT_TIMEOUT) is a connection failure', async () => {
    silent = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
    })
    const port = await new Promise<number>((resolve) => silent!.listen(0, '127.0.0.1', () => resolve((silent!.address() as { port: number }).port)))
    const r = await run(postgres(`postgres://u:p@127.0.0.1:${port}/x`, { max: 1, connect_timeout: 1, onnotice: () => {} }))
    expect(r).toMatchObject({ total: 1, failed: 1, failure: { kind: 'connection', code: 'connection_CONNECT_TIMEOUT', ordinal: 1 } })
  })
})
