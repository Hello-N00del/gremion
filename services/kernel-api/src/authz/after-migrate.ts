// services/kernel-api/src/authz/after-migrate.ts -- when the catalogue is written
// (brief s.5.2: "run after migrate"; idempotent, so a second run is a no-op).
//   * syncAfterMigrate: `kernel-api migrate` finished -> sync the same customer scope.
//     A migrate that failed syncs nothing. If the sync cannot be wired (no platform
//     DB / registry in the one-shot's environment) the skip is NAMED on stderr and the
//     migrate exit code stands: the boot sync below is the backstop.
//   * bootSync: serve start -> sync every active customer; a failure is logged, never
//     blocks the boot (a customer whose chain is behind is 503 at the gate anyway).
import type { AuthzCliDeps, AuthzCliIo } from './cli.ts'
import { runAuthzCli } from './cli.ts'

export async function syncAfterMigrate(migrateArgv: readonly string[], migrateExit: number, io: AuthzCliIo, getDeps: () => AuthzCliDeps & { close?: () => Promise<void> }): Promise<number> {
  if (migrateExit !== 0) return migrateExit
  const customer = migrateArgv[1] === '--customer' ? migrateArgv[2] : undefined
  let deps: ReturnType<typeof getDeps>
  try {
    deps = getDeps()
  } catch (err) {
    io.err(`AUTHZ-SYNC-SKIPPED after migrate (${(err as Error).message}); the boot sync will write the catalogue`)
    return migrateExit
  }
  try {
    const code = await runAuthzCli(['authz', 'sync', ...(customer ? ['--customer', customer] : [])], io, deps)
    return code === 0 ? 0 : 1
  } finally {
    await deps.close?.()
  }
}

export async function bootSync(deps: AuthzCliDeps, warn: (msg: string, fields?: Record<string, unknown>) => void): Promise<void> {
  try {
    const code = await runAuthzCli(['authz', 'sync'], { out: () => undefined, err: (line) => warn('authz boot sync', { line }) }, deps)
    if (code !== 0) warn('authz boot sync: at least one customer failed', { exit: code })
  } catch (err) {
    warn('authz boot sync failed', { err: (err as Error).message })
  }
}
