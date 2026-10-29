// services/kernel-api/src/main.ts — the process entry (bundled to
// dist/index.js in the image).
//
//   node dist/index.js                         serve (port PORT, default 3000)
//   node dist/index.js migrate [--customer id] the kernel-api-migrate one-shot (Q10)
//   node dist/index.js bodies <verb> ...       the operator's engine interface to the identity domain (TASK-080-a)
//
// Boot order (each step refuses the boot, naming why): the environment
// contract (TENANT_PROXY_SHARED_SECRET required, Q8), the shipped migrations
// against their manifest (TRD-353, Q18), the module declarations the image
// carries, then listen, then (NATS_URL set) the per-customer identity event
// relay. No migration and no catalogue write at boot (B21, A1).
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
import { jsonLogger, wireDeps } from './app/wire.ts'
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
  relayHost?.start()
  log.info('kernel-api: serving', { port: config.port, migrationFiles: files, releaseRef: config.releaseRef ?? null })
}

const argv = process.argv.slice(2)
if (argv[0] === 'migrate') {
  process.exitCode = await runMigrateCli(argv, process.env, { out: (l) => console.log(l), err: (l) => console.error(l) }, { dirs: DIRS, kernelRoot: KERNEL_ROOT })
} else if (argv[0] === 'bodies') {
  process.exitCode = await runBodiesCli(argv.slice(1), process.env, { out: (l) => console.log(l), err: (l) => console.error(l) })
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
