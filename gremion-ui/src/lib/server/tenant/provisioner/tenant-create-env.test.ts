// TASK-043 TDD 19: the tenant-create one-shot's environment contract (G3).
// `--help` imports every adapter; every variable phase A reads is checked
// BEFORE anything connects, and each missing one is a NAMED exit-2 failure,
// never a default. Spawns the real CLI entrypoint (tsx + the SvelteKit env shim).
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

  it('the retired provision verb names its replacement', () => {
    const r = run(['provision', 'musterstadt'], {})
    expect(r.status, r.out).toBe(2)
    expect(r.out).toMatch(/gremion-tenant create/)
  }, 90_000)
})
