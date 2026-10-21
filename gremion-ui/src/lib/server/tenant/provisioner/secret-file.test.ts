// R33 residual (TASK-044 item 4): tenant-create runs as root (builder stage) and
// wrote tenant secrets root 0:0 0600; gremion-ui reads them as uid 1000 (node)
// and got EACCES on a Linux volume too. Files under the tenant secrets dir are
// handed to the reader uid/gid (still 0600); everything else stays root-owned.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handToReader, readerIds } from '../../../../../scripts/tenant-secret-file'

describe('handToReader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-file-'))
  it('chowns a file under the tenant secrets dir to the reader uid:gid (default 1000:1000)', () => {
    const calls: Array<[string, number, number]> = []
    handToReader(join(dir, 'tenant_x_db'), dir, { chown: (p, u, g) => calls.push([p, u, g]) })
    expect(calls).toEqual([[join(dir, 'tenant_x_db'), 1000, 1000]])
  })
  it('does NOT chown a file outside the tenant secrets dir (the provisioner credential stays root-only)', () => {
    const calls: unknown[] = []
    handToReader(join(dir, '..', 'tenant_provisioner'), dir, { chown: (...a) => calls.push(a) })
    handToReader(join(dir + '-sibling', 'f'), dir, { chown: (...a) => calls.push(a) })
    expect(calls).toEqual([])
  })
  it('a failed chown on a file under the secrets dir is fatal (a root:root file is unreadable to the readers)', () => {
    expect(() =>
      handToReader(join(dir, 'f'), dir, {
        chown: () => {
          throw new Error('EPERM')
        }
      })
    ).toThrow(/chown .*EPERM/)
  })
  it('honours TENANT_SECRETS_UID / TENANT_SECRETS_GID and refuses non-numeric values', () => {
    expect(readerIds({ TENANT_SECRETS_UID: '1234', TENANT_SECRETS_GID: '4321' })).toEqual({ uid: 1234, gid: 4321 })
    expect(readerIds({})).toEqual({ uid: 1000, gid: 1000 })
    expect(() => readerIds({ TENANT_SECRETS_UID: 'node' })).toThrow(/TENANT_SECRETS_UID/)
  })
  it('the launcher script writeSecretFile uses it (wired)', () => {
    const src = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'tenant-provision.ts'), 'utf-8')
    expect(src).toMatch(/handToReader\(hostPath, tenantSecretsDir\(\)/)
  })
  rmSync(dir, { recursive: true, force: true })
})
