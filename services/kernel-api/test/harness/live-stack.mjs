#!/usr/bin/env node
// services/kernel-api/test/harness/live-stack.mjs -- the TASK-080-a live proof's
// scratch stack (test/bodies/proof.sh up | down | status):
//
//   * ONE PostgreSQL 18 on the kernel's digest-pinned image (tenant-store's harness
//     moduleImage), the superuser only for the harness's own scratch databases;
//   * the kernel's AUTHENTICATED NATS (docker-compose.yml's pinned image,
//     docker/nats/nats.conf, an accounts file `nats-auth init` renders), so the
//     proof publishes as the real `kernel-api` identity under the real account
//     permissions -- not a permissive dev broker.
//
// Plain `docker run` (never compose), names t080-<sha8>-{pg,nats}, published on
// 127.0.0.1 on free ports, removed BY NAME (never a prune, never a gremion_*
// object). State in <repo>/.scratch/t080/state.json in the SAME shape the
// kernel-api harness (scratch.ts) reads, plus the broker.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleImage } from '../../../../packages/tenant-store/test/harness/stack.mjs'

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ROOT = resolve(SERVICE, '../..')
const SCRATCH = join(ROOT, '.scratch', 't080')
const STATE_FILE = join(SCRATCH, 'state.json')
// The SAME reference as the nats service in docker-compose.yml.
const NATS_IMAGE = process.env.T080_NATS_IMAGE ?? 'nats:2.12.15-alpine@sha256:b270f5e2428354c0335612694d7dd2fb588148e567a5757fdff325ef9c9332e6'

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts })
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`)
  return r
}
export const sha8 = () => sh('git', ['-C', ROOT, 'rev-parse', '--short=8', 'HEAD']).stdout.trim()
const hostPath = (p) => (process.platform === 'win32' ? p.replaceAll('\\', '/') : p)
export const namesFor = (prefix) => ({ pg: `${prefix}-pg`, nats: `${prefix}-nats` })

export function checkNames(prefix, names) {
  const problems = []
  if (!/^t080-[0-9a-f]{8}$/.test(prefix)) problems.push(`project ${prefix} is not t080-<sha8>`)
  for (const [k, v] of Object.entries(names)) if (!v.startsWith(`${prefix}-`)) problems.push(`${k} ${v} does not start with ${prefix}-`)
  return problems
}

const publishedPort = (container, internal) => Number(sh('docker', ['port', container, `${internal}/tcp`]).stdout.trim().split('\n')[0].replace(/^.*:/, ''))
function waitFor(what, fn, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000
  for (;;) {
    if (fn()) return
    if (Date.now() > deadline) throw new Error(`${what} not ready within ${timeoutS}s`)
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'])
  }
}

function up() {
  if (existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} exists: a previous stack is up (run proof.sh down first)`)
  const prefix = `t080-${sha8()}`
  const names = namesFor(prefix)
  const problems = checkNames(prefix, names)
  if (problems.length) throw new Error(`refusing to start:\n  ${problems.join('\n  ')}`)
  for (const c of Object.values(names)) if (sh('docker', ['inspect', c], { allowFail: true }).status === 0) throw new Error(`container ${c} already exists: remove it by name first`)
  rmSync(SCRATCH, { recursive: true, force: true })
  const secretsDir = join(SCRATCH, 'secrets', 'nats')
  const accountsDir = join(SCRATCH, 'accounts')
  mkdirSync(secretsDir, { recursive: true })
  mkdirSync(accountsDir, { recursive: true })
  const state = { prefix, names, secretsDir, accountsDir }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) // early: a failed phase can still tear down by name
  sh('node', [join(ROOT, 'packages/nats-auth/bin/nats-auth.mjs'), 'init'], { env: { ...process.env, NATS_SECRETS_DIR: secretsDir, NATS_ACCOUNTS_DIR: accountsDir } })
  const user = 't080_admin'
  const password = randomBytes(18).toString('base64url')
  sh('docker', ['run', '-d', '--name', names.pg, '-p', '127.0.0.1::5432', '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${user}`, moduleImage()])
  sh('docker', [
    'run', '-d', '--name', names.nats, '-p', '127.0.0.1::4222',
    '-v', `${hostPath(join(ROOT, 'docker/nats/nats.conf'))}:/etc/nats/nats.conf:ro`,
    '-v', `${hostPath(accountsDir)}:/etc/nats/accounts:ro`,
    NATS_IMAGE, '-c', '/etc/nats/nats.conf',
  ])
  for (const c of Object.values(names)) {
    const ports = JSON.parse(sh('docker', ['inspect', '-f', '{{json .NetworkSettings.Ports}}', c]).stdout)
    for (const binds of Object.values(ports)) for (const b of binds ?? []) if (b.HostIp !== '127.0.0.1') throw new Error(`${c}: a port is published on ${b.HostIp}`)
  }
  waitFor('database', () => sh('docker', ['exec', names.pg, 'pg_isready', '-h', '127.0.0.1', '-U', user, '-d', user], { allowFail: true }).status === 0, 90)
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2500)']) // the entrypoint restarts the server once after init
  waitFor('database, stable', () => sh('docker', ['exec', names.pg, 'psql', '-h', '127.0.0.1', '-U', user, '-d', user, '-c', 'SELECT 1'], { allowFail: true }).status === 0, 60)
  waitFor('nats', () => sh('docker', ['exec', names.nats, 'wget', '-qO-', 'http://127.0.0.1:8222/healthz?js-enabled-only=true'], { allowFail: true }).status === 0, 60)
  const port = publishedPort(names.pg, 5432)
  Object.assign(state, {
    sha8: sha8(), port, poolerPort: port, user, password, db: user, image: moduleImage(), container: names.pg,
    natsPort: publishedPort(names.nats, 4222), natsContainer: names.nats,
  })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log(`[bodies-proof] stack ${prefix} up: postgres 127.0.0.1:${port}, nats 127.0.0.1:${state.natsPort}`)
}

function down() {
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : undefined
  const prefix = state?.prefix ?? `t080-${sha8()}`
  const names = state?.names ?? namesFor(prefix)
  const problems = checkNames(prefix, names)
  if (problems.length) throw new Error(`refusing to remove: ${problems.join('; ')}`)
  const left = []
  for (const c of [names.nats, names.pg]) {
    const r = sh('docker', ['rm', '-f', '-v', c], { allowFail: true })
    if (r.status !== 0 && !/no such/i.test(r.stderr ?? '')) left.push(`${c}: ${(r.stderr ?? '').trim()}`)
  }
  rmSync(STATE_FILE, { force: true })
  rmSync(SCRATCH, { recursive: true, force: true })
  if (left.length) throw new Error(`teardown left resources behind:\n  ${left.join('\n  ')}`)
  console.log(`[bodies-proof] stack ${prefix} removed (containers by name, their anonymous volumes with them)`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const cmd = process.argv[2]
    if (cmd === 'up') {
      const had = existsSync(STATE_FILE)
      try {
        up()
      } catch (err) {
        if (!had) {
          try {
            down()
          } catch {
            /* report the original failure */
          }
        }
        throw err
      }
    } else if (cmd === 'down') down()
    else if (cmd === 'status') {
      const s = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : undefined
      console.log(s ? JSON.stringify({ prefix: s.prefix, names: s.names, pgPort: s.port, natsPort: s.natsPort }) : 'no stack')
    } else throw new Error('usage: live-stack.mjs up | down | status')
  } catch (err) {
    console.error(`[bodies-proof] FAILED: ${err.message}`)
    process.exitCode = 1
  }
}
