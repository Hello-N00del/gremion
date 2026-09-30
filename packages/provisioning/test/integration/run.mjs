#!/usr/bin/env node
// packages/provisioning/test/integration/run.mjs — the provisioning package's
// scratch PostgreSQL and the only thing `pnpm --filter @gremion/provisioning
// test:integration` runs:
//
//   1. `docker run` ONE PostgreSQL 18 (the digest of docker-compose.yml's
//      x-module-postgres anchor), named t043-<sha8>-pg (sha8 = sha256 of this
//      checkout's real path), published on 127.0.0.1 only, on a free port. It
//      holds no gremion_platform: the bootstrap specs create it (Q15);
//   2. runs vitest with vitest.integration.config.ts;
//   3. removes the container BY NAME (with its anonymous volume) on exit,
//      SIGINT and SIGTERM. Never compose, never prune. T043_KEEP=1 keeps it.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = resolve(PKG, '../..')
const sha8 = createHash('sha256').update(realpathSync(REPO)).digest('hex').slice(0, 8)
const NAME = `t043-${sha8}-pg`

function moduleImage() {
  const lines = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8').split('\n')
  const start = lines.findIndex((l) => /^x-module-postgres:/.test(l))
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break
    const m = /^\s+image:\s*(\S+)\s*$/.exec(l)
    if (m && /^postgres:18[^@]*@sha256:[0-9a-f]{64}$/.test(m[1])) return m[1]
  }
  throw new Error('docker-compose.yml has no digest-pinned postgres:18 x-module-postgres image')
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

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`)
  return r
}

let created = false
function teardown() {
  if (!created) return
  created = false
  if (process.env.T043_KEEP === '1') {
    console.error(`[t043] T043_KEEP=1: keeping ${NAME}`)
    return
  }
  const r = sh('docker', ['rm', '-f', '-v', NAME], { allowFail: true })
  if (r.status !== 0 && !/no such/i.test(r.stderr ?? '')) {
    console.error(`[t043] teardown left ${NAME} behind: ${(r.stderr ?? '').trim()}`)
    process.exitCode = 1
  }
}

async function waitReady(user) {
  for (let i = 0; i < 90; i++) {
    const r = sh('docker', ['exec', NAME, 'pg_isready', '-h', '127.0.0.1', '-U', user, '-d', 'postgres'], { allowFail: true })
    if (r.status === 0) return
    await new Promise((res) => setTimeout(res, 1000))
  }
  throw new Error(`${NAME} did not become ready`)
}

async function main() {
  const image = moduleImage()
  const port = await freePort()
  const user = 't043_admin'
  const password = randomBytes(18).toString('base64url')
  sh('docker', ['rm', '-f', '-v', NAME], { allowFail: true })
  process.on('exit', teardown)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  created = true
  sh('docker', [
    'run', '-d', '--name', NAME, '--label', 'gremion.test=t043',
    '-e', `POSTGRES_USER=${user}`, '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=postgres',
    '-p', `127.0.0.1:${port}:5432`, image,
  ], { env: { ...process.env, POSTGRES_PASSWORD: password } })
  await waitReady(user)
  // pg_isready answers during the entrypoint's temporary server; wait for the real one.
  await new Promise((res) => setTimeout(res, 2000))
  await waitReady(user)
  const url = `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...process.argv.slice(2).filter((a) => a !== '--')], {
    cwd: PKG,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, T043_PG_ADMIN_URL: url, T043_SCRATCH: sha8 },
  })
  process.exitCode = r.status === 0 ? 0 : (r.status ?? 1)
}

main().catch((err) => {
  console.error(`[t043] ${err.message}`)
  process.exitCode = 1
})
