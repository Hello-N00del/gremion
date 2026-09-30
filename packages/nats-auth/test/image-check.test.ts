// scripts/image-check.sh's own judgement, driven with a `docker` shim on PATH
// (NATS_AUTH_MIGRATE_IMAGE set, so nothing is built and nothing is pulled).
// The real image run is `make test-nats-auth`'s last step; this suite pins
// WHAT the script accepts as proof:
//   - the runner negative passes ONLY on a proven import refusal
//     (ERR_MODULE_NOT_FOUND from node inside the runner); a docker failure,
//     a missing node, or any other load error fails the check (fail-closed,
//     house review r2 MEDIUM image-check.sh:182);
//   - the render check reads the render call's own output, never the
//     combined output of the three calls (r2 LOW image-check.sh:178).
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { NO_POSIX_BASH, posix } from './portable.ts'

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/image-check.sh')
const D = path.resolve(import.meta.dirname, `../../../.scratch/t024/unit/image-check-${process.pid}`)
const BIN = path.join(D, 'bin')
mkdirSync(BIN, { recursive: true })
afterAll(() => rmSync(D, { recursive: true, force: true }))

// The shim answers the two `docker run` calls image-check.sh makes: the
// migrate container (`sh -euc <checks>`) and the runner (`node -e <import>`).
const SHIM = path.join(BIN, 'docker')
writeFileSync(
  SHIM,
  [
    '#!/usr/bin/env bash',
    'case " $* " in',
    '  *" sh -euc "*) printf "%s\\n" "$SHIM_MIGRATE_OUT"; exit "${SHIM_MIGRATE_RC:-0}" ;;',
    '  *" node -e "*) printf "%s\\n" "$SHIM_RUNNER_OUT"; exit "${SHIM_RUNNER_RC:-0}" ;;',
    'esac',
    'echo "docker shim: unexpected call: $1 $2" >&2',
    'exit 99',
    '',
  ].join('\n'),
)
chmodSync(SHIM, 0o755)

const INIT1 = '[nats-auth] init: sys reload seed created; /etc/nats/accounts/accounts.conf written'
const WARN = '[nats-auth] init: WARNING the accounts file changed -- a RUNNING broker keeps the old one until the next reload (nats-auth ensure) or restart'
const INIT2 = '[nats-auth] init: sys reload seed present; /etc/nats/accounts/accounts.conf unchanged'
const RENDER = ['# rendered by @gremion/nats-auth', 'accounts {', '  SYS {', '    users: [', '    ]', '  }', '}']
const BEGIN = '@@nats-auth-render-begin@@'
const END = '@@nats-auth-render-end@@'
const migrateOut = (render: string[] = RENDER, extra: string[] = []) => [INIT1, WARN, INIT2, ...extra, BEGIN, ...render, END].join('\n')

interface Run {
  migrateOut?: string
  migrateRc?: number
  runnerOut?: string
  runnerRc?: number
  runner?: boolean
}
function run(o: Run = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ''}`,
    NATS_AUTH_MIGRATE_IMAGE: 't024-shim-migrate',
    SHIM_MIGRATE_OUT: o.migrateOut ?? migrateOut(),
    SHIM_MIGRATE_RC: String(o.migrateRc ?? 0),
    SHIM_RUNNER_OUT: o.runnerOut ?? '',
    SHIM_RUNNER_RC: String(o.runnerRc ?? 0),
  }
  if (o.runner === false) delete env.NATS_AUTH_RUNNER_IMAGE
  else env.NATS_AUTH_RUNNER_IMAGE = 't024-shim-runner'
  const r = spawnSync('bash', [posix(SCRIPT)], { encoding: 'utf8', env, timeout: 60_000 })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const REFUSED = 'NATS_AUTH_IMPORT_REFUSED ERR_MODULE_NOT_FOUND'
const RUNNER_OK = /runner t024-shim-runner cannot import @gremion\/nats-auth \(as required\)/

// Skipped on Windows, reason named in NO_POSIX_BASH (portable.ts); run it
// there from Git Bash with NATS_AUTH_POSIX_BASH=1.
describe.skipIf(NO_POSIX_BASH)('image-check.sh judgement (docker shim; skipped on Windows: NO_POSIX_BASH)', () => {
  test('positive control: complete migrate output and a proven refusal pass', () => {
    const r = run({ runnerOut: REFUSED, runnerRc: 3 })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(RUNNER_OK)
    expect(r.out).toMatch(/\[nats-auth-image\] OK/)
  })

  test('without NATS_AUTH_RUNNER_IMAGE the runner is not probed', () => {
    const r = run({ runner: false })
    expect(r.status, r.out).toBe(0)
    expect(r.out).not.toMatch(RUNNER_OK)
  })

  describe('runner negative is fail-closed (r2 MEDIUM)', () => {
    test('docker itself failing (image missing, daemon down) fails the check', () => {
      const r = run({ runnerOut: 'Unable to find image t024-shim-runner:latest locally', runnerRc: 125 })
      expect(r.status, r.out).toBe(1)
      expect(r.out).not.toMatch(RUNNER_OK)
      expect(r.out).toMatch(/could not prove/)
    })
    test('node missing in the runner (exit 127) fails the check', () => {
      const r = run({ runnerOut: 'sh: node: not found', runnerRc: 127 })
      expect(r.status, r.out).toBe(1)
      expect(r.out).not.toMatch(RUNNER_OK)
    })
    test('exit 3 without the refusal marker fails the check', () => {
      const r = run({ runnerOut: '', runnerRc: 3 })
      expect(r.status, r.out).toBe(1)
      expect(r.out).not.toMatch(RUNNER_OK)
    })
    test('the package present but failing to load (another error code) fails the check', () => {
      const r = run({ runnerOut: 'NATS_AUTH_IMPORT_REFUSED ERR_UNKNOWN_FILE_EXTENSION', runnerRc: 3 })
      expect(r.status, r.out).toBe(1)
      expect(r.out).not.toMatch(RUNNER_OK)
    })
    test('an import that succeeds fails the check', () => {
      const r = run({ runnerOut: '', runnerRc: 0 })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/CAN import/)
    })
  })

  describe('migrate checks read their own call (r2 LOWs)', () => {
    test('SYS outside the render section does not stand in for the render output', () => {
      const r = run({ runner: false, migrateOut: migrateOut(['accounts {', '}'], ['note: SYS account expected']) })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/render printed no SYS account/)
    })
    test('no render section at all fails', () => {
      const r = run({ runner: false, migrateOut: [INIT1, WARN, INIT2, '  SYS {'].join('\n') })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/render printed no SYS account/)
    })
    test('a failing migrate container fails with its output', () => {
      const r = run({ runner: false, migrateOut: 'second init changed accounts.conf', migrateRc: 14 })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/second init changed accounts.conf/)
    })
  })
})
