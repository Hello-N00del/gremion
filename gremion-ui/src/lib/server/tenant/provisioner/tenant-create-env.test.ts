// TASK-043 TDD 19: the tenant-create one-shot's environment contract (G3).
// `--help` imports every adapter; every variable phase A reads is checked
// BEFORE anything connects, and each missing one is a NAMED exit-2 failure,
// never a default. Spawns the real CLI entrypoint (tsx + the SvelteKit env shim).
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EnableRefused, refusalLine } from '../../../../../scripts/tenant-provision-gate'

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const REPO = join(UI, '..')
const FIXTURE = join(REPO, 'test', 'host', 'fixtures', 'customer-provision', 'env', 'pg-admin.url')
const MODULE_SERVERS = ['BOARD', 'CALENDAR', 'CONTENT', 'FINANCE', 'NEWSLETTER', 'VAULT']

const CONTRACT: Record<string, string> = {
  PLATFORM_DATABASE_URL: 'postgres://gremion_platform:unit@postgres-unitstack:5432/gremion_platform',
  KERNEL_PG_ADMIN_FILE: FIXTURE,
  ...Object.fromEntries(MODULE_SERVERS.flatMap((id) => [[`MODULE_PG_ADMIN_${id}_FILE`, FIXTURE], [`MODULE_APP_PASSWORD_${id}_FILE`, FIXTURE]])),
  TENANT_EXPORT_DIR: '/var/lib/gremion/exports',
  GREMION_DISABLE_SEEDS: 'true',
  DOMAIN: 'platform.example',
  DATABASE_URL: 'postgres://gremion:unit@pgbouncer-unitstack:6432/gremion',
  CONTROL_DATABASE_URL: 'postgres://control:unit@postgres-unitstack:5432/control',
  NATS_URL: 'nats://nats-unitstack:4222',
  // review B2-HIGH (r2): these were read only AFTER the platform pool opened,
  // so a missing one leaked the pool and hung the one-shot instead of exit 2
  PLATFORM_DOMAIN: 'platform.example',
  EDGE_BIND_IP: '192.0.2.10',
  TENANT_PROVISIONER_SECRET_FILE: FIXTURE,
  // TASK-075: the release every gremion_platform and module-database ledger
  // row records (release_ref); compose passes the colour's IMAGE_TAG
  GREMION_RELEASE_REF: 'dist-v0.0.1',
}

const FLAGS = [
  'musterstadt',
  '--host', 'rat.musterstadt.example',
  '--config', FIXTURE,
  '--operator', '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e',
  '--it-admin', 'it@musterstadt.example',
  '--council-admin', 'rat@musterstadt.example',
  '--enable', 'calendar,vault',
]

function run(args: string[], env: Record<string, string>) {
  const base: Record<string, string> = {}
  for (const k of ['PATH', 'Path', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT']) {
    const v = process.env[k]
    if (v !== undefined) base[k] = v
  }
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/tenant-provision.mjs', ...args], {
    cwd: UI,
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` }
}

describe('tenant-create --help (TDD 19)', () => {
  it('imports every adapter and prints the verbs', () => {
    const r = run(['--help'], {})
    expect(r.status, r.out).toBe(0)
    for (const verb of ['init', 'phase-a', 'record-step', 'phase-b', 'render-router', 'suspend', 'resume', 'reconcile', 'status', 'operator-add']) {
      expect(r.out).toContain(verb)
    }
  }, 90_000)
})

describe('tenant-create phase-a env contract (TDD 19, G3)', () => {
  it.each(Object.keys(CONTRACT))('without %s: exit 2 naming it, before any connection', (missing) => {
    const env = { ...CONTRACT }
    delete env[missing]
    const r = run(['phase-a', ...FLAGS], env)
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain(missing)
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/)
  }, 90_000)

  it('GREMION_DISABLE_SEEDS other than "true" is refused (the seeds would run)', () => {
    const r = run(['phase-a', ...FLAGS], { ...CONTRACT, GREMION_DISABLE_SEEDS: 'false' })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toMatch(/GREMION_DISABLE_SEEDS must be "true"/)
  }, 90_000)

  it('a PLATFORM_DATABASE_URL on the pooler is refused (the runner needs the server itself)', () => {
    const r = run(['phase-a', ...FLAGS], { ...CONTRACT, PLATFORM_DATABASE_URL: 'postgres://gremion_platform:unit@pgbouncer-unitstack:6432/gremion_platform' })
    expect(r.status, r.out).toBe(2)
    expect(r.out).toMatch(/PLATFORM_DATABASE_URL points at the pooler/)
  }, 90_000)

  it.each([
    ['suspend', 'PLATFORM_DOMAIN', ['suspend', 'musterstadt', '--operator', '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e']],
    ['resume', 'TENANT_EXPORT_DIR', ['resume', 'musterstadt', '--operator', '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e']],
    ['record-step', 'TENANT_PROVISIONER_SECRET_FILE', ['record-step', 'musterstadt', 'mail_principal_issued', '--operator', '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e']],
  ])('%s without %s: exit 2 naming it, before the platform pool opens (no hang, no connection error)', (_verb, missing, args) => {
    const env = { ...CONTRACT }
    delete env[missing as string]
    const r = run(args as string[], env)
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain(missing as string)
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo|CONNECT_TIMEOUT/)
  }, 90_000)

  // r3 verifier MEDIUM #70: `init` makes the panel's read-only role, so it
  // needs that role's name and password -- named, before any connection.
  it.each(['PANEL_DB_USER', 'PANEL_DB_PASSWORD'])('init without %s: exit 2 naming it, before any connection', (missing) => {
    const env: Record<string, string> = { ...CONTRACT, PANEL_DB_USER: 'gremion_panel', PANEL_DB_PASSWORD: 'unit-panel-password-0123456789' }
    delete env[missing]
    const r = run(['init'], env)
    expect(r.status, r.out).toBe(2)
    expect(r.out).toContain(missing)
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo|CONNECT_TIMEOUT/)
  }, 90_000)

  // TASK-075: init migrates gremion_platform, so it names the release too.
  it('init without GREMION_RELEASE_REF, or with one that is no release ref: exit 2 naming it, before any connection', () => {
    const panel = { PANEL_DB_USER: 'gremion_panel', PANEL_DB_PASSWORD: 'unit-panel-password-0123456789' }
    const env: Record<string, string> = { ...CONTRACT, ...panel }
    delete env.GREMION_RELEASE_REF
    for (const e of [env, { ...CONTRACT, ...panel, GREMION_RELEASE_REF: 'x'.repeat(65) }, { ...CONTRACT, ...panel, GREMION_RELEASE_REF: 'a b' }]) {
      const r = run(['init'], e)
      expect(r.status, r.out).toBe(2)
      expect(r.out).toContain('GREMION_RELEASE_REF')
      expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo|CONNECT_TIMEOUT/)
    }
  }, 180_000)

  it('suspend with an operator that is not a uuid is refused (exit 2)', () => {
    const r = run(['suspend', 'musterstadt', '--operator', 'root'], CONTRACT)
    expect(r.status, r.out).toBe(2)
    expect(r.out).toMatch(/--operator .*uuid/)
  }, 90_000)

  it('the retired provision verb names its replacement', () => {
    const r = run(['provision', 'musterstadt'], {})
    expect(r.status, r.out).toBe(2)
    expect(r.out).toMatch(/gremion-tenant create/)
  }, 90_000)
})

// TASK-044 (lane note A5, D4): the level-1 gate's verbs. The release tip is
// GREMION_RELEASE_TIP (derived by gremion-tenant from the authenticated
// release tree), never a flag; it is NOT part of the env contract above --
// without it the gate refuses an enable NO_RELEASE_TIP, it never exits 2.
describe('tenant-create gate verbs (TASK-044)', () => {
  const OP = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'

  it('--help lists enable-module, dpia-record, isolation-record, gate-status and regate', () => {
    const r = run(['--help'], {})
    expect(r.status, r.out).toBe(0)
    for (const verb of ['enable-module', 'dpia-record', 'isolation-record', 'gate-status', 'regate']) expect(r.out).toContain(verb)
  }, 90_000)

  it('dpia-record without --document-ref is refused (exit 2) before any connection: the decision is written down whatever requires_dpia says', () => {
    const r = run(['dpia-record', 'musterstadt', 'votes', '--operator', OP, '--requires-dpia', 'no', '--reason-codes', 'no_special_category'], CONTRACT)
    expect(r.status, r.out).toBe(2)
    expect(r.out).toMatch(/--document-ref/)
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo|CONNECT_TIMEOUT/)
  }, 90_000)

  it('enable-module and regate with an operator that is not a uuid, or without a module, are refused (exit 2)', () => {
    for (const args of [
      ['enable-module', 'musterstadt', 'votes', '--operator', 'root'],
      ['enable-module', 'musterstadt', '--operator', OP],
      ['regate', 'musterstadt', 'votes', '--operator', 'root'],
    ]) {
      const r = run(args, CONTRACT)
      expect(r.status, `${args.join(' ')}\n${r.out}`).toBe(2)
    }
  }, 180_000)

  it('isolation-record of a file that cannot be read, and gate-status without PLATFORM_DATABASE_URL, are named exit-2 failures', () => {
    const missing = run(['isolation-record', join(REPO, '.scratch', 'no-such-evidence.json')], CONTRACT)
    expect(missing.status, missing.out).toBe(2)
    expect(missing.out).toMatch(/cannot be read/)
    const env = { ...CONTRACT }
    delete env.PLATFORM_DATABASE_URL
    const gs = run(['gate-status'], env)
    expect(gs.status, gs.out).toBe(2)
    expect(gs.out).toContain('PLATFORM_DATABASE_URL')
  }, 180_000)

  // A gate refusal is a refusal, not a usage error: exit 1, `REFUSED <code>: <reason>`
  // on stderr (lane note A5). The mapping is a pure function plus the one catch in
  // main(); the catch must consult it BEFORE the usage classification, so a refusal
  // can never fall into the exit-2 branch (watched RED with the order swapped).
  it('an EnableRefused is rendered as REFUSED <code>: <reason>; any other error is not a refusal', () => {
    const refused = new EnableRefused('NO_RELEASE_TIP', 'the tip is unset', 'votes', null, null)
    expect(refusalLine(refused)).toBe('REFUSED NO_RELEASE_TIP: the tip is unset')
    expect(refusalLine(new Error('NO_RELEASE_TIP: boom'))).toBeNull()
    expect(refusalLine('NO_RELEASE_TIP')).toBeNull()
  })

  it('the entrypoint exits 1 on a refusal, checked before the exit-2 usage classification', () => {
    const src = readFileSync(join(UI, 'scripts', 'tenant-provision.ts'), 'utf8')
    const catchAt = src.indexOf('.catch((err) => {')
    expect(catchAt).toBeGreaterThan(0)
    const block = src.slice(catchAt)
    const refusal = block.indexOf('refusalLine(err)')
    const usage = block.indexOf('const usage =')
    expect(refusal).toBeGreaterThan(0)
    expect(usage).toBeGreaterThan(refusal)
    const refusalBranch = block.slice(refusal, usage)
    expect(refusalBranch).toMatch(/process\.exitCode = 1\b/)
    expect(refusalBranch).not.toMatch(/process\.exitCode = 2\b/)
  })
})
