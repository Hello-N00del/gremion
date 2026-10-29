// services/kernel-api/src/main.ts — the process entry (bundled to
// dist/index.js in the image).
//
//   node dist/index.js                         serve (port PORT, default 3000)
//   node dist/index.js migrate [--customer id] the kernel-api-migrate one-shot (Q10)
//   node dist/index.js authz sync|sweep [--customer id]  the authz catalogue / grant sweep verbs (TASK-081)
//   node dist/index.js bodies <verb> ...       the operator's engine interface to the identity domain (TASK-080-a)
//
// Boot order (each step refuses the boot, naming why): the environment
// contract (TENANT_PROXY_SHARED_SECRET required, Q8), the shipped migrations
// against their manifest (TRD-353, Q18), the module declarations the image
// carries, then listen, then (NATS_URL set) the per-customer identity event
// relay. No migration at boot (B21, A1). The authz catalogue is written
// idempotently once the server listens (and after `migrate`, brief s.5.2).
//
// Layout: this file (src/main.ts in the tree, dist/index.js in the image) sits
// ONE level below the service root; the service root sits at
// services/kernel-api of a kernel tree (the image mirrors it under /app), so
// the register (scripts/migrations/ranges.json) and modules/ are found the
// same way in both.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBodiesCli } from './bodies/cli.ts'
import { buildApp } from './app/build.ts'
import { readConfig } from './app/config.ts'
import { authzCliDeps, jsonLogger, wireDeps } from './app/wire.ts'
import { bootSync, syncAfterMigrate } from './authz/after-migrate.ts'
import { runAuthzCli } from './authz/cli.ts'
import { describeSweepInterval, parseSweepInterval } from './authz/sweep-interval.ts'
import { assertShippedMigrations } from './migrate/boot-check.ts'
import { KERNEL_API_MIGRATION_DIRS } from './migrate/chain.ts'
import { runMigrateCli } from './migrate/cli.ts'
import { natsOpener } from './outbox/nats.ts'
import { createRelayHost } from './outbox/relay-host.ts'

const SERVICE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const KERNEL_ROOT = join(SERVICE_ROOT, '..', '..')
const DIRS = KERNEL_API_MIGRATION_DIRS.map((d) => join(SERVICE_ROOT, d))
const SPEC = join(SERVICE_ROOT, 'openapi', 'kernel-core.json')

async function serve(): Promise<void> {
  const log = jsonLogger()
  // a malformed AUTHZ_SWEEP_INTERVAL_MS refuses the boot, before anything is wired or opened
  const everyMs = parseSweepInterval(process.env.AUTHZ_SWEEP_INTERVAL_MS)
  const config = readConfig(process.env, { modulesRoot: join(KERNEL_ROOT, 'modules'), kernelRoot: KERNEL_ROOT })
  const files = assertShippedMigrations(DIRS)
  const wired = wireDeps(config, { dirs: DIRS, log })
  const app = buildApp({ uploadCeilingBytes: process.env.UPLOAD_CEILING_BYTES, logger: true }, wired.deps, { spec: SPEC })
  // The identity event relay (TASK-080-a): one relay per active, current customer, drained on shutdown.
  const relayHost = config.natsUrl
    ? createRelayHost({
        tenancy: wired.deps.tenancy,
        tenantDb: wired.deps.tenantDb,
        gate: wired.deps.gate,
        openJetStream: natsOpener({ url: config.natsUrl, ...(config.natsSecretsDir ? { secretsDir: config.natsSecretsDir } : {}) }),
        log,
      })
    : undefined
  if (!relayHost) log.warn('kernel-api: NATS_URL is not set: the identity event relay is OFF (idt.outbox rows wait for it; nothing is lost)')
  const stop = async (signal: string) => {
    log.info('kernel-api: stopping', { signal })
    await app.close().catch(() => undefined)
    await relayHost?.stop().catch(() => undefined)
    await wired.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void stop('SIGTERM'))
  process.once('SIGINT', () => void stop('SIGINT'))
  await app.listen({ host: config.host, port: config.port })
  // the grant sweep (brief s.5.6): every AUTHZ_SWEEP_INTERVAL_MS (default 60 s, 0 = off, e.g. when the verb runs from cron; anything but a non-negative integer refuses the boot); never overlaps itself
  log.info(describeSweepInterval(everyMs))
  if (everyMs > 0) {
    const sweepDeps = authzCliDeps(wired)
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      void runAuthzCli(['authz', 'sweep'], { out: () => undefined, err: (l) => log.warn('authz sweep', { line: l }) }, sweepDeps)
        .catch((err) => log.warn('authz sweep failed', { err: (err as Error).message }))
        .finally(() => {
          running = false
        })
    }, everyMs)
    timer.unref()
  }
  void bootSync(authzCliDeps(wired), (msg, fields) => log.warn(msg, fields))
  relayHost?.start()
  log.info('kernel-api: serving', { port: config.port, migrationFiles: files, releaseRef: config.releaseRef ?? null })
}

const argv = process.argv.slice(2)
if (argv[0] === 'migrate') {
  const io = { out: (l: string) => console.log(l), err: (l: string) => console.error(l) }
  const migrated = await runMigrateCli(argv, process.env, io, { dirs: DIRS, kernelRoot: KERNEL_ROOT })
  // brief s.5.2: the catalogue is written after migrate (idempotent; a failed migrate syncs nothing)
  process.exitCode = await syncAfterMigrate(argv, migrated, io, () => {
    const wired = wireDeps(readConfig(process.env, { modulesRoot: join(KERNEL_ROOT, 'modules'), kernelRoot: KERNEL_ROOT }), { dirs: DIRS })
    return { ...authzCliDeps(wired), close: () => wired.close() }
  })
} else if (argv[0] === 'bodies') {
  process.exitCode = await runBodiesCli(argv.slice(1), process.env, { out: (l) => console.log(l), err: (l) => console.error(l) })
} else if (argv[0] === 'authz') {
  const io = { out: (l: string) => console.log(l), err: (l: string) => console.error(l) }
  if ((argv[1] !== 'sync' && argv[1] !== 'sweep') || argv.length > 4) {
    process.exitCode = await runAuthzCli(argv, io, undefined as never)
  } else {
    try {
      const wired = wireDeps(readConfig(process.env, { modulesRoot: join(KERNEL_ROOT, 'modules'), kernelRoot: KERNEL_ROOT }), { dirs: DIRS })
      process.exitCode = await runAuthzCli(argv, io, authzCliDeps(wired)).finally(() => wired.close())
    } catch (err) {
      console.error(`kernel-api authz: ${(err as Error).message}`)
      process.exitCode = 1
    }
  }
} else if (argv.length === 0) {
  try {
    await serve()
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'kernel-api: refused to boot', ts: new Date().toISOString(), service: 'kernel-api', err: (err as Error).message }))
    process.exit(1)
  }
} else {
  console.error('usage: kernel-api            (serve)\n       kernel-api migrate [--customer <customer id>]')
  process.exitCode = 2
}
