import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { isInside, assertSecretsDirSafe } from '../../scripts/check-tenant-secrets-dir.mjs'

// FIX3-C: the §7.2 provisioner credential must NEVER resolve inside the
// bind-mounted TENANT_SECRETS_DIR (which is mounted ro into the tenant data-plane
// container at /run/secrets/tenants, D-SECMOUNT). assertSecretsDirSafe is pure
// path math, so these tests use OS-appropriate absolute paths via the same
// path.resolve the guard uses.
const ROOT = path.resolve('/srv/app')

describe('check-tenant-secrets-dir — isInside (containment, path-only)', () => {
  it('a file directly inside the dir is inside', () => {
    expect(isInside(path.resolve(ROOT, 'secrets'), path.resolve(ROOT, 'secrets/tenant_provisioner'))).toBe(true)
  })
  it('a deeply-nested file is inside', () => {
    expect(isInside(path.resolve(ROOT, 'secrets'), path.resolve(ROOT, 'secrets/a/b/c'))).toBe(true)
  })
  it('the dir itself counts as inside (equal)', () => {
    expect(isInside(path.resolve(ROOT, 'secrets'), path.resolve(ROOT, 'secrets'))).toBe(true)
  })
  it('a sibling file is NOT inside', () => {
    expect(isInside(path.resolve(ROOT, 'secrets/tenants'), path.resolve(ROOT, 'secrets/tenant_provisioner'))).toBe(
      false,
    )
  })
  it('a prefix-but-not-segment sibling is NOT inside (secrets/tenants vs secrets/tenants-evil)', () => {
    expect(isInside(path.resolve(ROOT, 'secrets/tenants'), path.resolve(ROOT, 'secrets/tenants-evil/x'))).toBe(false)
  })
})

describe('check-tenant-secrets-dir — assertSecretsDirSafe (the FIX3-C guard)', () => {
  it('PASSES the safe default layout: secrets/tenants dir, sibling provisioner cred', () => {
    const r = assertSecretsDirSafe(
      path.resolve(ROOT, 'secrets/tenants'),
      path.resolve(ROOT, 'secrets/tenant_provisioner'),
    )
    expect(r.ok).toBe(true)
  })

  it('FAILS when TENANT_SECRETS_DIR is the secrets/ ROOT (the headline misconfig — cred is inside)', () => {
    const r = assertSecretsDirSafe(path.resolve(ROOT, 'secrets'), path.resolve(ROOT, 'secrets/tenant_provisioner'))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/INSIDE TENANT_SECRETS_DIR/)
    expect(r.reason).toMatch(/dedicated leaf directory/i)
  })

  it('FAILS when the provisioner cred is nested deeper inside TENANT_SECRETS_DIR', () => {
    const r = assertSecretsDirSafe(
      path.resolve(ROOT, 'secrets/tenants'),
      path.resolve(ROOT, 'secrets/tenants/sub/tenant_provisioner'),
    )
    expect(r.ok).toBe(false)
  })

  it('FAILS when TENANT_SECRETS_DIR equals the provisioner cred path', () => {
    const r = assertSecretsDirSafe(
      path.resolve(ROOT, 'secrets/tenant_provisioner'),
      path.resolve(ROOT, 'secrets/tenant_provisioner'),
    )
    expect(r.ok).toBe(false)
  })

  it('PASSES when the cred lives in a different tree entirely', () => {
    const r = assertSecretsDirSafe(path.resolve(ROOT, 'secrets/tenants'), path.resolve('/etc/gremion/provisioner'))
    expect(r.ok).toBe(true)
  })

  it('PASSES a prefix-but-not-segment near-collision (secrets/tenants vs secrets/tenants-old/cred)', () => {
    const r = assertSecretsDirSafe(
      path.resolve(ROOT, 'secrets/tenants'),
      path.resolve(ROOT, 'secrets/tenants-old/tenant_provisioner'),
    )
    expect(r.ok).toBe(true)
  })
})
