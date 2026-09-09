import { describe, it, expect, vi, beforeEach } from 'vitest'

const envMock: Record<string, string> = {}
vi.mock('$env/dynamic/private', () => ({ env: envMock }))

// T7 file: allowlist — read mock so the resolver never actually touches /run/secrets.
const readFileSyncMock = vi.fn<(path: string, enc: string) => string>()
vi.mock('node:fs', () => {
  const readFileSync = (p: string, e: string) => readFileSyncMock(p, e)
  return { readFileSync, default: { readFileSync } }
})

describe('resolveSecret', () => {
  beforeEach(() => {
    for (const k of Object.keys(envMock)) delete envMock[k]
    readFileSyncMock.mockReset()
    readFileSyncMock.mockReturnValue('s3cret\n')
  })

  // T7 — file: refs MUST resolve under /run/secrets/ (the container mount prefix,
  // D-SECMOUNT); the resolver path-normalizes and rejects traversal.
  it('resolves an allow-listed file: ref under /run/secrets/ (trimmed)', async () => {
    const { resolveSecret } = await import('./secrets')
    expect(resolveSecret('file:/run/secrets/x')).toBe('s3cret')
    expect(readFileSyncMock).toHaveBeenCalledWith('/run/secrets/x', 'utf-8')
  })
  it('resolves a per-tenant file: ref under /run/secrets/tenants/ (D-SECMOUNT prefix)', async () => {
    const { resolveSecret } = await import('./secrets')
    expect(resolveSecret('file:/run/secrets/tenants/tenant_t2_db')).toBe('s3cret')
    expect(readFileSyncMock).toHaveBeenCalledWith('/run/secrets/tenants/tenant_t2_db', 'utf-8')
  })
  it('rejects a file: ref outside /run/secrets/ (fail-closed, no read)', async () => {
    const { resolveSecret } = await import('./secrets')
    expect(() => resolveSecret('file:/etc/passwd')).toThrow(/\/run\/secrets/)
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })
  it('rejects a traversal that escapes /run/secrets/ via .. (fail-closed, no read)', async () => {
    const { resolveSecret } = await import('./secrets')
    expect(() => resolveSecret('file:/run/secrets/../x')).toThrow(/\/run\/secrets/)
    expect(readFileSyncMock).not.toHaveBeenCalled()
  })
  it('resolves an env: ref from $env/dynamic/private', async () => {
    envMock.AUTH_KEYCLOAK_SECRET = 'env-secret'
    const { resolveSecret } = await import('./secrets')
    expect(resolveSecret('env:AUTH_KEYCLOAK_SECRET')).toBe('env-secret')
  })
  it('throws on an unknown scheme', async () => {
    const { resolveSecret } = await import('./secrets')
    expect(() => resolveSecret('raw:hunter2')).toThrow(/unsupported secret ref/i)
  })
  it('throws (fail-closed) when an env ref is unset', async () => {
    const { resolveSecret } = await import('./secrets')
    expect(() => resolveSecret('env:MISSING_VAR')).toThrow(/MISSING_VAR/)
  })
})

// T7 (D-SECMOUNT) — host↔container path mapping for HOST-side scripts (provisioner,
// backup) where /run/secrets does NOT exist. Translates the per-tenant container
// prefix to the host bind-mount source.
describe('tenantSecretHostPath', () => {
  beforeEach(() => { for (const k of Object.keys(envMock)) delete envMock[k] })

  it('translates file:/run/secrets/tenants/<name> to the default host path', async () => {
    const { tenantSecretHostPath } = await import('./secrets')
    expect(tenantSecretHostPath('file:/run/secrets/tenants/tenant_t2_db'))
      .toBe('./secrets/tenants/tenant_t2_db')
  })
  it('honors TENANT_SECRETS_DIR for the host root', async () => {
    envMock.TENANT_SECRETS_DIR = '/srv/secrets/tenants'
    const { tenantSecretHostPath } = await import('./secrets')
    expect(tenantSecretHostPath('file:/run/secrets/tenants/tenant_t2_db'))
      .toBe('/srv/secrets/tenants/tenant_t2_db')
  })
  it('round-trips: the host path basename matches the container ref name', async () => {
    const { tenantSecretHostPath } = await import('./secrets')
    const ref = 'file:/run/secrets/tenants/tenant_t2_db'
    const host = tenantSecretHostPath(ref)
    expect(host.endsWith('/tenant_t2_db')).toBe(true)
  })
  it('refuses a ref outside the tenants subdir (fail-closed)', async () => {
    const { tenantSecretHostPath } = await import('./secrets')
    expect(() => tenantSecretHostPath('file:/run/secrets/x')).toThrow(/tenants/)
  })
  it('refuses a traversal out of the tenants subdir', async () => {
    const { tenantSecretHostPath } = await import('./secrets')
    expect(() => tenantSecretHostPath('file:/run/secrets/tenants/../x')).toThrow(/tenants/)
  })
  it('refuses a non-file: scheme', async () => {
    const { tenantSecretHostPath } = await import('./secrets')
    expect(() => tenantSecretHostPath('env:FOO')).toThrow(/file:/)
  })
})
