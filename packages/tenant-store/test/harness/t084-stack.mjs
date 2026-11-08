#!/usr/bin/env node
// packages/tenant-store/test/harness/t084-stack.mjs
//
// TASK-084-a scratch harness: exactly ONE PostgreSQL 18 container
//   container  t084-<sha8>-pg        (sha8 = sha256 of this checkout's real path)
//   volume     t084-<sha8>-pgdata
//   network    t084-<sha8>-net
// on the image of docker-compose.yml's x-module-postgres anchor (digest pin),
// published on 127.0.0.1 only, on a free port. No compose file. The admin
// password is generated, written to the 0600 file <repo>/.scratch/t084/admin.pw
// and handed to the container ONLY as POSTGRES_PASSWORD_FILE plus a read-only
// bind of that file: never `-e POSTGRES_PASSWORD=...` (it would sit in argv and
// in `docker inspect`). The spec connection URL goes to a 0600 file as well
// (T084_ADMIN_URL_FILE). Teardown is BY EXPLICIT NAME in a trap (exit, SIGINT,
// SIGTERM): container, volume, network. Never `compose down`, never prune.
// T084_KEEP_STACK=1 keeps them.
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { moduleImage } from './stack.mjs'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO = resolve(PKG, '../..')
const SCRATCH = join(REPO, '.scratch', 't084')

export const sha8 = createHash('sha256').update(realpathSync(REPO)).digest('hex').slice(0, 8)
export const names = {
  container: `t084-${sha8}-pg`,
  volume: `t084-${sha8}-pgdata`,
  network: `t084-${sha8}-net`,
}
export const ADMIN_USER = 't084_admin'
export const SECRET_TARGET = '/run/secrets/t084_pw'

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
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`)
  }
  return r
}

/** The docker run argv. Pure, so a test can assert it never carries the password. */
export function runArgs({ image, port, pwFile }) {
  return [
    'run', '-d',
    '--name', names.container,
    '--label', 'org.gremion.scratch=t084',
    '--network', names.network,
    '-p', `127.0.0.1:${port}:5432`,
    '-v', `${names.volume}:/var/lib/postgresql`,
    '-v', `${pwFile}:${SECRET_TARGET}:ro`,
    '-e', `POSTGRES_USER=${ADMIN_USER}`,
    '-e', 'POSTGRES_DB=postgres',
    '-e', `POSTGRES_PASSWORD_FILE=${SECRET_TARGET}`,
    image,
  ]
}

let created = false
function teardown() {
  if (!created) return
  created = false
  if (process.env.T084_KEEP_STACK === '1') {
    console.error(`[t084] T084_KEEP_STACK=1: keeping ${names.container}, ${names.volume}, ${names.network}`)
    return
  }
  const left = []
  for (const [what, args] of /** @type {[string, string[]][]} */ ([
    ['container', ['rm', '-f', '-v', names.container]],
    ['volume', ['volume', 'rm', names.volume]],
    ['network', ['network', 'rm', names.network]],
  ])) {
    const r = sh('docker', args, { allowFail: true })
    if (r.status !== 0 && !/no such/i.test(r.stderr ?? '')) left.push(`${what} ${args.at(-1)}: ${(r.stderr ?? '').trim()}`)
  }
  rmSync(join(SCRATCH, 'state.json'), { force: true })
  rmSync(join(SCRATCH, 'admin.url'), { force: true })
  rmSync(join(SCRATCH, 'admin.pw'), { force: true })
  if (left.length) {
    console.error(`[t084] teardown left resources behind:\n  ${left.join('\n  ')}`)
    process.exitCode = 1
  } else {
    console.error(`[t084] teardown: removed ${names.container}, ${names.volume}, ${names.network}`)
  }
}

async function waitReady(password) {
  for (let i = 0; i < 90; i++) {
    const r = sh('docker', ['exec', names.container, 'pg_isready', '-h', '127.0.0.1', '-U', ADMIN_USER, '-d', 'postgres'], { allowFail: true })
    if (r.status === 0) return
    await new Promise((res) => setTimeout(res, 1000))
  }
  void password
  throw new Error(`${names.container} was not ready after 90 s`)
}

async function main() {
  const image = moduleImage()
  const port = await freePort()
  mkdirSync(SCRATCH, { recursive: true })
  const pwFile = join(SCRATCH, 'admin.pw')
  const password = randomBytes(24).toString('base64url')
  writeFileSync(pwFile, password, { mode: 0o600 })
  chmodSync(pwFile, 0o600)

  process.on('exit', teardown)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
  created = true
  sh('docker', ['network', 'create', '--label', 'org.gremion.scratch=t084', names.network])
  sh('docker', ['volume', 'create', '--label', 'org.gremion.scratch=t084', names.volume])
  sh('docker', runArgs({ image, port, pwFile }))
  await waitReady(password)

  const urlFile = join(SCRATCH, 'admin.url')
  writeFileSync(urlFile, `postgresql://${ADMIN_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`, { mode: 0o600 })
  chmodSync(urlFile, 0o600)
  const stateFile = join(SCRATCH, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ sha8, port, user: ADMIN_USER, container: names.container, image }))

  const r = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.t084.config.ts', ...process.argv.slice(2).filter((a) => a !== '--')], {
    cwd: PKG,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, T084_ADMIN_URL_FILE: urlFile, T084_SCRATCH: sha8, T084_STATE: stateFile },
  })
  process.exitCode = r.status === 0 ? 0 : (r.status ?? 1)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[t084] ${err.message}`)
    process.exitCode = 1
  })
}
