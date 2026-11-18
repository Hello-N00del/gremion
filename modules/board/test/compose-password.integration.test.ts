// modules/board/test/compose-password.integration.test.ts
//
// The ONE password of the board leaf (docker-compose.app.yml `board-service`), proven by authenticating:
//   1. the module lifecycle's ensureModuleRoles sets the role m_board_app from the FILE
//      etc/secrets/tenant-create/module_app_password_board (what tenant-create does at every enable, reading the
//      file trimmed like its reqFileEnv);
//   2. `docker compose config` of the app project, with BOARD_APP_PASSWORD set to that same file content (what
//      gremion-init-secrets derives; test/host/board-compose.bats pins the derivation), gives the leaf's
//      GREMION_BOARD_PG_URL;
//   3. a connection with exactly that URL (only the host and port swapped for the scratch server) authenticates
//      as m_board_app. A different password is refused with 28P01, so the check can fail.
// If the env carried a second generated value, (3) would be 28P01 for every customer while the leaf's /healthz
// stays green.
//
// Needs docker (compose config) and the scratch Postgres of the other integration suites (BOARD_TEST_PG_URL, a
// throwaway container on a non-5432 port, scram authentication). No value is printed: a failure names the
// variable and the SQLSTATE, never the URL.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureModuleRoles } from '@gremion/tenant-store/lifecycle'
import { connectAdmin, scratchServerUrl, type ScratchSql } from './support/scratch-pg.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const APP_ROLE = 'm_board_app'
const OWNER_ROLE = 'm_board'

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: REPO, env: { ...process.env, ...extraEnv }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (r.error) throw new Error(`${cmd} could not be run: ${r.error.message}`)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

let admin: ScratchSql
let root = ''
let rendered: { url: URL; filePassword: string }

/** The fixed app env the pooled-stack guard renders (every other value is a placeholder). */
const APP_ENV = 'test/host/fixtures/pooled-stack/app-blue.env'

/** The URL a leaf container would receive, from `docker compose config` of the app project. */
function renderedLeafUrl(boardAppPassword: string): URL {
  const r = run('docker', ['compose', '--env-file', APP_ENV, 'config', '--format', 'json'], {
    COMPOSE_PROFILES: 'board',
    BOARD_APP_PASSWORD: boardAppPassword,
  })
  // never print the render: it carries the values under test
  if (r.status !== 0) throw new Error(`docker compose config refused the app env (exit ${r.status}): ${r.stderr.split('\n')[0] ?? ''}`.slice(0, 300).replace(boardAppPassword, '<value>'))
  const config = JSON.parse(r.stdout) as { services?: Record<string, { environment?: Record<string, string> }> }
  const value = config.services?.['board-service']?.environment?.GREMION_BOARD_PG_URL
  if (!value) throw new Error('the render has no board-service GREMION_BOARD_PG_URL')
  return new URL(value)
}

beforeAll(async () => {
  admin = connectAdmin()
  await admin.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`)
  await admin.unsafe(`DROP ROLE IF EXISTS ${OWNER_ROLE}`)

  // the file gremion-tenant writes (openssl rand -hex 32 plus a newline), read the way the one-shot reads it (trimmed)
  root = mkdtempSync(path.join(tmpdir(), 'bd-board-pw-'))
  const file = path.join(root, 'module_app_password_board')
  writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  const filePassword = readFileSync(file, 'utf8').trim()

  rendered = { url: renderedLeafUrl(filePassword), filePassword }
  // the scratch server stands in for board-postgres: only host and port are swapped, user and password are the render's
  const scratch = new URL(scratchServerUrl())
  rendered.url.hostname = scratch.hostname
  rendered.url.port = scratch.port
  // the role as tenant-create sets it at enable: from the FILE
  await ensureModuleRoles(admin, 'board', filePassword)
}, 60_000)

afterAll(async () => {
  if (admin) {
    await admin.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => undefined)
    await admin.unsafe(`DROP ROLE IF EXISTS ${OWNER_ROLE}`).catch(() => undefined)
    await admin.end({ timeout: 2 })
  }
  if (root) rmSync(root, { recursive: true, force: true })
})

async function connectedAs(url: URL): Promise<string> {
  const sql = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 10 })
  try {
    const [row] = await sql<{ u: string }[]>`SELECT current_user AS u`
    return row?.u ?? ''
  } finally {
    await sql.end({ timeout: 2 })
  }
}

describe('board leaf password: one source, proven by authenticating', () => {
  it('the rendered URL names the module APP role, never the server admin, and the password is the file', () => {
    expect(decodeURIComponent(rendered.url.username)).toBe(APP_ROLE)
    expect(decodeURIComponent(rendered.url.password)).toBe(rendered.filePassword)
    expect(rendered.filePassword.length).toBeGreaterThanOrEqual(32)
  })

  it('a connection with exactly the URL the render produced authenticates as m_board_app (no 28P01)', async () => {
    expect(await connectedAs(rendered.url)).toBe(APP_ROLE)
  })

  it('a different password is refused with 28P01: the check can fail', async () => {
    const wrong = new URL(rendered.url.toString())
    wrong.password = encodeURIComponent(`${rendered.filePassword}x`)
    const err = await connectedAs(wrong).then(
      () => null,
      (e: unknown) => e as { code?: string },
    )
    expect(err?.code, 'the scratch server did not ask for the password (trust authentication): this suite needs scram').toBe('28P01')
  })
})
