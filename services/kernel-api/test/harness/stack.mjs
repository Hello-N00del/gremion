#!/usr/bin/env node
// services/kernel-api/test/harness/stack.mjs -- the kernel API's scratch
// stack (brief s.9), and the only thing `pnpm --filter @gremion/kernel-api
// test:integration` runs:
//
//   1. plain `docker run` (never compose, never the repo's compose files):
//      ONE PostgreSQL 18 on the kernel's digest-pinned image (docker-compose.yml
//      x-module-postgres, the TASK-019 pin) and a PgBouncer 1.25.2 in
//      transaction mode in front of it (the migrate job must refuse it), on a
//      network of their own, published on 127.0.0.1 only, on free ports, every
//      name t077-<sha8>-* (sha8 of this checkout's real path);
//   2. runs vitest with vitest.integration.config.ts (args pass through);
//   3. removes the two containers (with their anonymous volumes) and the
//      network BY NAME on exit, SIGINT or SIGTERM. Never prunes, never touches a
//      resource it did not create. T077_KEEP_STACK=1 keeps them.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleImage, POOLER_IMAGE } from '../../../../packages/tenant-store/test/harness/stack.mjs'

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = resolve(SERVICE, '../..')
const STATE_FILE = join(SERVICE, '.stack-state.json')

export const sha8 = createHash('sha256').update(realpathSync(REPO)).digest('hex').slice(0, 8)
export const names = { pg: `t077-${sha8}-pg`, pooler: `t077-${sha8}-pgb`, network: `t077-${sha8}-net` }

function sh(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args[0]} exited ${r.status}: ${(r.stderr || '').trim().slice(-400)}`)
  return r
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

let created = false
function teardown() {
  if (!created) return
  created = false
  if (process.env.T077_KEEP_STACK === '1') {
    console.error(`[t077] T077_KEEP_STACK=1: keeping ${names.pooler}, ${names.pg}, ${names.network}`)
    return
  }
  const left = []
  for (const args of [
    ['rm', '-f', '-v', names.pooler],
    ['rm', '-f', '-v', names.pg],
    ['network', 'rm', names.network],
  ]) {
    const r = sh('docker', args, { allowFail: true })
    if (r.status !== 0 && !/no such/i.test(r.stderr ?? '')) left.push(`${args.at(-1)}: ${(r.stderr ?? '').trim()}`)
  }
  rmSync(STATE_FILE, { force: true })
  if (left.length) {
    console.error(`[t077] teardown left resources behind:\n  ${left.join('\n  ')}`)
    process.exitCode = 1
  }
}

async function main() {
  // a leftover of an earlier run of THIS checkout (same t077-<sha8> names) is refused, not reused
  for (const n of [names.pg, names.pooler]) {
    if (sh('docker', ['inspect', '--format', '{{.Name}}', n], { allowFail: true }).status === 0) {
      throw new Error(`container ${n} already exists (an earlier run of this checkout left it): remove it by name first`)
    }
  }
  const image = moduleImage()
  const port = await freePort()
  let poolerPort = await freePort()
  while (poolerPort === port) poolerPort = await freePort()
  const user = 't077_admin'
  const db = 't077_admin'
  const password = randomBytes(18).toString('base64url')

  process.on('exit', teardown)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  created = true
  sh('docker', ['network', 'create', names.network])
  sh('docker', ['run', '-d', '--name', names.pg, '--network', names.network, '--network-alias', 'pg', '-p', `127.0.0.1:${port}:5432`,
    '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${db}`, image])
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    ready = sh('docker', ['exec', names.pg, 'pg_isready', '-h', '127.0.0.1', '-U', user, '-d', db], { allowFail: true }).status === 0
    if (!ready) sleep(1000)
  }
  if (!ready) throw new Error(`${names.pg} did not become ready in 120 s`)
  // the entrypoint restarts the server once after init: wait for a stable answer
  sleep(1500)
  for (let i = 0; i < 30; i++) {
    if (sh('docker', ['exec', names.pg, 'psql', '-h', '127.0.0.1', '-U', user, '-d', db, '-c', 'SELECT 1'], { allowFail: true }).status === 0) break
    sleep(1000)
  }
  sh('docker', ['run', '-d', '--name', names.pooler, '--network', names.network, '-p', `127.0.0.1:${poolerPort}:5432`,
    '-e', 'DB_HOST=pg', '-e', `DB_USER=${user}`, '-e', `DB_PASSWORD=${password}`, '-e', 'POOL_MODE=transaction', '-e', 'AUTH_TYPE=scram-sha-256', POOLER_IMAGE])

  writeFileSync(STATE_FILE, JSON.stringify({ sha8, port, poolerPort, user, password, db, image, container: names.pg }))
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...process.argv.slice(2)], {
    cwd: SERVICE,
    stdio: 'inherit',
    env: { ...process.env, T077_STATE: STATE_FILE, T077_SCRATCH: sha8 },
  })
  process.exitCode = r.status === 0 ? 0 : (r.status ?? 1)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[t077] ${err.message}`)
    process.exitCode = 1
  })
}
