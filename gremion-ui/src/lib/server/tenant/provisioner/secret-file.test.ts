// R33 residual (TASK-044 item 4): tenant-create runs as root (builder stage) and
// wrote tenant secrets root 0:0 0600; gremion-ui reads them as uid 1000 (node)
// and got EACCES on a Linux volume too. Files under the tenant secrets dir are
// handed to the reader uid/gid (still 0600); everything else stays root-owned.
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handToReader, readerIds, writeReaderConfigFile } from '../../../../../scripts/tenant-secret-file'

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

// #49: tenant-create (root) left /data/<slug> and its config.json root:root
// (0640): gremion-ui (uid 1000) got EACCES, the brand identity was empty and a
// new customer answered 503. The config file and its slug dir go to the reader.
describe('writeReaderConfigFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-config-'))
  const path = join(root, 'proof-x', 'config.json')
  it('hands the tmp file (before the rename) and the slug dir to the reader uid:gid, then renames', () => {
    const calls: Array<[string, number, number]> = []
    writeReaderConfigFile(path, '{"a":1}\n', { pid: 7, chown: (p, u, g) => calls.push([p, u, g]) })
    expect(calls).toEqual([
      [`${path}.tmp-7`, 1000, 1000],
      [join(root, 'proof-x'), 1000, 1000],
    ])
    expect(readFileSync(path, 'utf-8')).toBe('{"a":1}\n')
    expect(existsSync(`${path}.tmp-7`)).toBe(false)
  })
  it('honours TENANT_SECRETS_UID/GID (the same reader contract as the secrets)', () => {
    const calls: Array<[string, number, number]> = []
    writeReaderConfigFile(path, '{}\n', { env: { TENANT_SECRETS_UID: '1001', TENANT_SECRETS_GID: '1002' }, chown: (p, u, g) => calls.push([p, u, g]) })
    expect(calls.map((c) => [c[1], c[2]])).toEqual([[1001, 1002], [1001, 1002]])
  })
  it('a failed chown is fatal, names EACCES, and leaves neither a tmp file nor a new config behind', () => {
    const p2 = join(root, 'proof-y', 'config.json')
    expect(() =>
      writeReaderConfigFile(p2, '{}\n', {
        pid: 9,
        chown: () => {
          throw new Error('EPERM')
        },
      }),
    ).toThrow(/EACCES/)
    expect(existsSync(`${p2}.tmp-9`)).toBe(false)
    expect(existsSync(p2)).toBe(false)
  })
  it('tenant-provision writes the tenant config through it (no root-owned writeFileSync path left)', () => {
    const src = readFileSync(join(__dirname, '../../../../../scripts/tenant-provision.ts'), 'utf-8')
    const body = src.slice(src.indexOf('function writeConfigFile('), src.indexOf('function writeConfigFile(') + 300)
    expect(body).toMatch(/writeReaderConfigFile\(path, text\)/)
    expect(body.split('\n}')[0]).not.toMatch(/writeFileSync/)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
})
