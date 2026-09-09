import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { scanForEnvViolations } from '../../scripts/check-tenant-env-guard.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, '../../scripts/__fixtures__/env-guard')
const ALLOWLIST = ['allowed-inside-resolver']

describe('check-tenant-env-guard — scanForEnvViolations', () => {
  it('flags a per-tenant env read OUTSIDE the allowlist', async () => {
    const violations = await scanForEnvViolations(FIXTURES, { allowlist: ALLOWLIST })
    const bad = violations.filter((v) => v.file.endsWith('violation-outside-allowlist.ts'))
    expect(bad.map((v) => v.varName).sort()).toEqual(['DATABASE_URL', 'NEXTCLOUD_ADMIN_PASSWORD', 'SYNAPSE_SERVER_NAME'])
  })
  it('does NOT flag a read INSIDE the allowlisted resolver path', async () => {
    const violations = await scanForEnvViolations(FIXTURES, { allowlist: ALLOWLIST })
    expect(violations.filter((v) => v.file.includes('allowed-inside-resolver'))).toEqual([])
  })
  it('does NOT flag a file that only reads non-per-tenant env', async () => {
    const violations = await scanForEnvViolations(FIXTURES, { allowlist: ALLOWLIST })
    expect(violations.filter((v) => v.file.endsWith('clean-file.ts'))).toEqual([])
  })
})

// D-GUARD-TESTS (T14 §7.7): tests legitimately pin env behavior and do NOT ship,
// so the build-failing guard SKIPS `*.test.ts` + `*.integration.test.ts`. A planted
// per-tenant read inside such a file must NOT be reported (it is not a build hazard),
// while the SAME read in a shipped `.ts` file still is.
describe('check-tenant-env-guard — D-GUARD-TESTS test-file skip', () => {
  it('does NOT report a per-tenant read planted in a *.test.ts file', async () => {
    const violations = await scanForEnvViolations(FIXTURES, { allowlist: ALLOWLIST })
    expect(violations.filter((v) => v.file.endsWith('planted-read.test.ts'))).toEqual([])
  })
  it('still reports the same read in a shipped (non-test) .ts file', async () => {
    const violations = await scanForEnvViolations(FIXTURES, { allowlist: ALLOWLIST })
    expect(violations.some((v) => v.file.endsWith('violation-outside-allowlist.ts'))).toBe(true)
  })
})

describe('check-tenant-env-guard — CLI exit codes', () => {
  const SCRIPT = path.resolve(__dirname, '../../scripts/check-tenant-env-guard.mjs')
  it('exits NON-ZERO with --enforce when scanning the fixture tree', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--enforce', '--root', FIXTURES], { encoding: 'utf-8' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('env.DATABASE_URL')
  })
  it('exits ZERO in report-only mode (no --enforce)', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--root', FIXTURES], { encoding: 'utf-8' })
    expect(res.status).toBe(0)
    expect(res.stderr).toContain('report-only')
  })
})

// #256-7: walk() used to swallow readdir failures (`catch { return }`) and
// report the unreadable subtree as CLEAN — a fail-OPEN guard slated to gate
// builds via --enforce at P2.1c. A readdir failure must now be a hard error
// (loud exit 1), matching build-migration-manifest.mjs's failed-to-read path.
describe('check-tenant-env-guard — fail-closed walk (#256-7)', () => {
  const SCRIPT = path.resolve(__dirname, '../../scripts/check-tenant-env-guard.mjs')
  const MISSING_ROOT = path.join(FIXTURES, 'no-such-subdir')

  it('scanForEnvViolations REJECTS when a directory cannot be read', async () => {
    await expect(scanForEnvViolations(MISSING_ROOT, { allowlist: ALLOWLIST })).rejects.toThrow(
      /failed to read directory/,
    )
  })

  it('CLI exits 1 LOUDLY (even without --enforce) when the scan root is unreadable', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--root', MISSING_ROOT], { encoding: 'utf-8' })
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('failed to read directory')
  })
})
