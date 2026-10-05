#!/usr/bin/env node
// packages/events/scripts/stack.mjs -- the TASK-079 scratch stack (proof.sh up | down | status).
//
//   up      a Postgres 18 (the image of docker-compose.yml's x-module-postgres anchor, by digest:
//           tenant-store's harness `moduleImage`, the only thing imported from it) and the kernel's
//           authenticated NATS (the state project's digest-pinned image, docker/nats/nats.conf and an
//           accounts file `nats-auth init` renders), each a plain `docker run` named
//           t079-<sha8>-{pg,nats}, published on 127.0.0.1 only, on ephemeral ports.
//   down    removes exactly those containers and the one volume BY NAME. Never `compose down`,
//           never a prune, never a name that does not start with the project prefix.
//   status  prints the state (no secrets).
//
// State: <repo>/.scratch/t079/state.json (git-ignored). `up` refuses while it exists. Seeds, the
// accounts file and the Postgres password live under .scratch/t079/ and are never printed.
// Equivalent of the harness's checkRenderedConfig: every name this file creates is asserted to
// carry the project prefix BEFORE docker is asked to create it (checkNames), and every published
// port is read back and asserted to be bound to 127.0.0.1 (checkPublished).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleImage } from '../../tenant-store/test/harness/stack.mjs'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = resolve(PKG, '../..')
const SCRATCH = join(ROOT, '.scratch', 't079')
const STATE_FILE = join(SCRATCH, 'state.json')
// The SAME reference as the nats service in docker-compose.yml (and TASK-024's proof).
const NATS_IMAGE = process.env.EVENTS_NATS_IMAGE ?? 'nats:2.12.15-alpine@sha256:b270f5e2428354c0335612694d7dd2fb588148e567a5757fdff325ef9c9332e6'

export const sha8 = () => sh('git', ['-C', ROOT, 'rev-parse', '--short=8', 'HEAD']).stdout.trim()

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts })
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} exited ${r.status}: ${(r.stderr || '').trim().split('\n').slice(-3).join(' | ')}`)
  }
  return r
}

/** Docker Desktop on Windows reads bind sources in the drive form (C:/...). */
function hostPath(p) {
  return process.platform === 'win32' ? p.replaceAll('\\', '/') : p
}

export function namesFor(prefix) {
  return { pg: `${prefix}-pg`, nats: `${prefix}-nats`, volume: `${prefix}-pgdata` }
}

/** Every name this stack creates must carry the project prefix (the checkRenderedConfig equivalent). */
export function checkNames(prefix, names) {
  const problems = []
  if (!/^t079-[0-9a-f]{8}$/.test(prefix)) problems.push(`project ${prefix} is not t079-<sha8>`)
  for (const [k, v] of Object.entries(names)) if (!v.startsWith(`${prefix}-`)) problems.push(`${k} ${v} does not start with ${prefix}-`)
  return problems
}

/** Every published port of `container` must be bound to 127.0.0.1 only. */
export function checkPublished(ports) {
  const problems = []
  let n = 0
  for (const [port, binds] of Object.entries(ports ?? {})) {
    for (const b of binds ?? []) {
      n++
      if (b.HostIp !== '127.0.0.1') problems.push(`port ${port} is published on ${b.HostIp || 'all interfaces'}`)
    }
  }
  if (n === 0) problems.push('no published port')
  return problems
}

const publishedPort = (container, internal) => {
  const out = sh('docker', ['port', container, `${internal}/tcp`]).stdout.trim().split('\n')[0]
  return Number(out.replace(/^.*:/, ''))
}

function waitFor(what, fn, timeoutS) {
  const deadline = Date.now() + timeoutS * 1000
  for (;;) {
    if (fn()) return
    if (Date.now() > deadline) throw new Error(`${what} not ready within ${timeoutS}s`)
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'])
  }
}

export function readState() {
  if (!existsSync(STATE_FILE)) return undefined
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
}

function up() {
  if (existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} exists: a previous stack is up (run proof.sh down first)`)
  const prefix = `t079-${sha8()}`
  const names = namesFor(prefix)
  const problems = checkNames(prefix, names)
  if (problems.length) throw new Error(`refusing to start the scratch stack:\n  ${problems.join('\n  ')}`)
  for (const c of [names.pg, names.nats]) {
    if (sh('docker', ['inspect', c], { allowFail: true }).status === 0) throw new Error(`a container named ${c} already exists: another run of this commit? remove it yourself if not`)
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(join(SCRATCH, 'secrets', 'nats'), { recursive: true })
  mkdirSync(join(SCRATCH, 'accounts'), { recursive: true })
  const secretsDir = join(SCRATCH, 'secrets', 'nats')
  const accountsDir = join(SCRATCH, 'accounts')
  const state = { prefix, names, secretsDir, accountsDir, startedAt: new Date().toISOString() }
  // Written early so a failed phase can still tear down by name.
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

  // 1. the SYS reload seed and an accounts file, BEFORE the broker starts (nats-auth Q12).
  sh('node', [join(ROOT, 'packages/nats-auth/bin/nats-auth.mjs'), 'init'], { env: { ...process.env, NATS_SECRETS_DIR: secretsDir, NATS_ACCOUNTS_DIR: accountsDir } })

  // 2. Postgres 18, superuser for the harness only (the services run as a NOSUPERUSER owner).
  const pgUser = 't079_admin'
  const pgPassword = randomBytes(18).toString('base64url')
  sh('docker', [
    'run', '-d', '--name', names.pg, '-p', '127.0.0.1::5432', '-v', `${names.volume}:/var/lib/postgresql`,
    '-e', `POSTGRES_USER=${pgUser}`, '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', 'POSTGRES_DB=postgres',
    moduleImage(),
  ])
  // 3. the authenticated broker (nats.conf + the rendered accounts file, read-only).
  sh('docker', [
    'run', '-d', '--name', names.nats, '-p', '127.0.0.1::4222',
    '-v', `${hostPath(join(ROOT, 'docker/nats/nats.conf'))}:/etc/nats/nats.conf:ro`,
    '-v', `${hostPath(accountsDir)}:/etc/nats/accounts:ro`,
    NATS_IMAGE, '-c', '/etc/nats/nats.conf',
  ])
  for (const c of [names.pg, names.nats]) {
    const ports = JSON.parse(sh('docker', ['inspect', '-f', '{{json .NetworkSettings.Ports}}', c]).stdout)
    const bad = checkPublished(ports)
    if (bad.length) throw new Error(`${c}: ${bad.join('; ')}`)
  }
  waitFor('postgres', () => sh('docker', ['exec', names.pg, 'pg_isready', '-h', '127.0.0.1', '-U', pgUser, '-d', 'postgres'], { allowFail: true }).status === 0, 90)
  waitFor('nats', () => sh('docker', ['exec', names.nats, 'wget', '-qO-', 'http://127.0.0.1:8222/healthz?js-enabled-only=true'], { allowFail: true }).status === 0, 60)
  Object.assign(state, {
    pg: { port: publishedPort(names.pg, 5432), user: pgUser, password: pgPassword },
    nats: { port: publishedPort(names.nats, 4222) },
  })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  console.log(`[events-proof] stack ${prefix} up: postgres 127.0.0.1:${state.pg.port}, nats 127.0.0.1:${state.nats.port}`)
}

function down() {
  const state = readState()
  const prefix = state?.prefix ?? `t079-${sha8()}`
  const names = state?.names ?? namesFor(prefix)
  const problems = checkNames(prefix, names)
  if (problems.length) throw new Error(`refusing to remove: ${problems.join('; ')}`)
  const left = []
  for (const [what, args] of [
    ['container', ['rm', '-f', '-v', names.nats]],
    ['container', ['rm', '-f', '-v', names.pg]],
    ['volume', ['volume', 'rm', '-f', names.volume]],
  ]) {
    const r = sh('docker', args, { allowFail: true })
    if (r.status !== 0 && !/no such/i.test(r.stderr ?? '')) left.push(`${what} ${args.at(-1)}: ${(r.stderr ?? '').trim()}`)
  }
  rmSync(STATE_FILE, { force: true })
  if (left.length) throw new Error(`teardown left resources behind:\n  ${left.join('\n  ')}`)
  console.log(`[events-proof] stack ${prefix} removed (containers and volume, by name)`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const cmd = process.argv[2]
  try {
    if (cmd === 'up') {
      // A refused `up` (a stack already exists) must NOT tear that stack down: only a failure after
      // this call wrote the state removes what it created.
      const had = existsSync(STATE_FILE)
      try {
        up()
      } catch (err) {
        if (!had) {
          try {
            down()
          } catch {
            /* the original failure is the one to report */
          }
        }
        throw err
      }
    } else if (cmd === 'down') down()
    else if (cmd === 'status') {
      const s = readState()
      console.log(s ? JSON.stringify({ prefix: s.prefix, names: s.names, pgPort: s.pg?.port, natsPort: s.nats?.port, startedAt: s.startedAt }) : 'no stack')
    } else throw new Error('usage: stack.mjs up | down | status')
  } catch (err) {
    console.error(`[events-proof] FAILED: ${err.message}`)
    process.exitCode = 1
  }
}
