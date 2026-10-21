#!/usr/bin/env node
// services/kernel-api/test/authz/stack.mjs -- TASK-081's scratch stack: ONE
// PostgreSQL 18 (the kernel's digest-pinned module image) via plain `docker
// run` on 127.0.0.1, every name t081-<sha8>-*, removed BY NAME on exit, SIGINT
// or SIGTERM. Never compose, never prune, never touches a resource it did not
// create. Runs vitest with vitest.authz-int.config.ts. T081_KEEP_STACK=1 keeps it.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleImage } from '../../../../packages/tenant-store/test/harness/stack.mjs'

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = resolve(SERVICE, '../..')
const STATE_FILE = join(SERVICE, '.t081-state.json')
export const sha8 = createHash('sha256').update(realpathSync(REPO)).digest('hex').slice(0, 8)
export const names = { pg: `t081-${sha8}-pg` }

function sh(cmd, args, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args[0]} exited ${r.status}: ${(r.stderr || '').trim().slice(-400)}`)
  return r
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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

let created = false
function teardown() {
  if (!created) return
  created = false
  if (process.env.T081_KEEP_STACK === '1') {
    console.error(`[t081] keeping ${names.pg}`)
    return
  }
  const r = sh('docker', ['rm', '-f', '-v', names.pg], { allowFail: true })
  if (r.status !== 0 && !/no such/i.test(r.stderr ?? '')) {
    console.error(`[t081] teardown left ${names.pg}: ${(r.stderr ?? '').trim()}`)
    process.exitCode = 1
  }
  rmSync(STATE_FILE, { force: true })
}

async function main() {
  if (sh('docker', ['inspect', '--format', '{{.Name}}', names.pg], { allowFail: true }).status === 0) {
    throw new Error(`container ${names.pg} already exists: remove it by name first`)
  }
  const image = moduleImage()
  const port = await freePort()
  const user = 't081_admin'
  const db = 't081_admin'
  const password = randomBytes(18).toString('base64url')
  process.on('exit', teardown)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  created = true
  sh('docker', ['run', '-d', '--name', names.pg, '-p', `127.0.0.1:${port}:5432`, '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${db}`, image])
  let ready = false
  for (let i = 0; i < 120 && !ready; i++) {
    ready = sh('docker', ['exec', names.pg, 'pg_isready', '-h', '127.0.0.1', '-U', user, '-d', db], { allowFail: true }).status === 0
    if (!ready) sleep(1000)
  }
  if (!ready) throw new Error(`${names.pg} did not become ready in 120 s`)
  sleep(1500)
  for (let i = 0; i < 30; i++) {
    if (sh('docker', ['exec', names.pg, 'psql', '-h', '127.0.0.1', '-U', user, '-d', db, '-c', 'SELECT 1'], { allowFail: true }).status === 0) break
    sleep(1000)
  }
  writeFileSync(STATE_FILE, JSON.stringify({ sha8, port, user, password, db, image, container: names.pg }))
  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.authz-int.config.ts', ...process.argv.slice(2)], {
    cwd: SERVICE,
    stdio: 'inherit',
    env: { ...process.env, T081_STATE: STATE_FILE, T081_SCRATCH: sha8 },
  })
  process.exitCode = r.status === 0 ? 0 : (r.status ?? 1)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[t081] ${err.message}`)
    process.exitCode = 1
  })
}
