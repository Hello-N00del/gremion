// R33 residual (TASK-044 item 4): tenant-create runs as root (builder stage) and
// wrote tenant secrets root 0:0 0600; gremion-ui reads them as uid 1000 (node)
// and got EACCES on a Linux volume too. Files under the tenant secrets dir are
// handed to the reader uid/gid (still 0600); everything else stays root-owned.
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handConfigToReader, handToReader, isTenantConfigPath, readerIds, writeReaderConfigFile } from '../../../../../scripts/tenant-secret-file'

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
describe('writeReaderConfigFile / handConfigToReader', () => {
  const root = mkdtempSync(join(tmpdir(), 'reader-config-'))
  const env = { TENANT_DATA_ROOT: root }
  const path = join(root, 'proof-x', 'config.json')
  const rec = () => {
    const calls: Array<[string, string | number, number, number]> = []
    return {
      calls,
      fchown: (fd: number, u: number, g: number) => calls.push(['fd', fd, u, g]),
      lchown: (p: string, u: number, g: number) => calls.push(['path', p, u, g]),
    }
  }
  it('hands the slug dir (no symlink follow) and the open tmp (by descriptor) to the reader, then renames', () => {
    const r = rec()
    writeReaderConfigFile(path, '{"a":1}\n', { env, suffix: 's1', fchown: r.fchown, lchown: r.lchown })
    expect(r.calls.map((c) => [c[0], c[0] === 'path' ? c[1] : 'fd', c[2], c[3]])).toEqual([
      ['path', join(root, 'proof-x'), 1000, 1000],
      ['fd', 'fd', 1000, 1000],
    ])
    expect(readFileSync(path, 'utf-8')).toBe('{"a":1}\n')
    expect(existsSync(`${path}.tmp-s1`)).toBe(false)
  })
  it('honours TENANT_SECRETS_UID/GID (the same reader contract as the secrets)', () => {
    const r = rec()
    writeReaderConfigFile(path, '{}\n', { env: { ...env, TENANT_SECRETS_UID: '1001', TENANT_SECRETS_GID: '1002' }, fchown: r.fchown, lchown: r.lchown })
    expect(r.calls.map((c) => [c[2], c[3]])).toEqual([[1001, 1002], [1001, 1002]])
  })
  it('creates the tmp exclusively: a pre-planted tmp name is refused, never overwritten', () => {
    const r = rec()
    writeFileSync(`${path}.tmp-planted`, 'planted')
    expect(() => writeReaderConfigFile(path, '{}\n', { env, suffix: 'planted', fchown: r.fchown, lchown: r.lchown })).toThrow(/EEXIST/)
    expect(readFileSync(`${path}.tmp-planted`, 'utf-8')).toBe('planted')
  })
  it('a failed chown is fatal, keeps the cause, names EACCES, and leaves no tmp and no new config', () => {
    const p2 = join(root, 'proof-y', 'config.json')
    expect(() =>
      writeReaderConfigFile(p2, '{}\n', {
        env,
        suffix: 's9',
        lchown: () => undefined,
        fchown: () => {
          throw new Error('EPERM')
        },
      }),
    ).toThrow(/EPERM.*EACCES/)
    expect(existsSync(`${p2}.tmp-s9`)).toBe(false)
    expect(existsSync(p2)).toBe(false)
  })
  it('refuses a path that is not <data root>/<slug>/config.json (never hands a shared dir to the reader)', () => {
    const r = rec()
    expect(() => writeReaderConfigFile(join(root, 'config.json'), '{}\n', { env, ...r })).toThrow(/not a direct child of the data root/)
    expect(() => writeReaderConfigFile(join(root, 'a', 'b', 'config.json'), '{}\n', { env, ...r })).toThrow(/not a direct child/)
    expect(r.calls).toEqual([])
  })
  it('handConfigToReader repairs an existing (pre-#49) config and its dir, and leaves a missing one alone', () => {
    const r = rec()
    expect(handConfigToReader(path, { env, lchown: r.lchown })).toBe(true)
    expect(r.calls.map((c) => c[1])).toEqual([join(root, 'proof-x'), path])
    expect(handConfigToReader(join(root, 'nope', 'config.json'), { env, lchown: r.lchown })).toBe(false)
    expect(r.calls).toHaveLength(2)
  })
  it('tenant-provision writes every tenant config through the reader writer and wires the repair', () => {
    const src = readFileSync(join(__dirname, '../../../../../scripts/tenant-provision.ts'), 'utf-8')
    const fnBody = (name: string): string => {
      const at = src.indexOf(`function ${name}(`)
      expect(at, `function ${name} exists`).toBeGreaterThan(-1)
      return src.slice(at, src.indexOf('\n}', at))
    }
    expect(fnBody('writeConfigFile')).toMatch(/writeReaderConfigFile\(path, text\)/)
    expect(fnBody('writeConfigFile')).not.toMatch(/writeFileSync/)
    expect(fnBody('repairConfigOwner')).toMatch(/handConfigToReader\(path\)/)
    // materialize-config: the default (tenant data root) path goes through the reader writer
    expect(fnBody('cmdMaterializeConfig')).toMatch(/if \(!isTenantConfigPath\(path\)\)/)
    expect(fnBody('cmdMaterializeConfig')).toMatch(/else writeReaderConfigFile\(path, /)
    expect(src.match(/repairConfigOwner,/g)?.length).toBe(2)
  })
  it('refuses a slug "dir" that is a file or symlink, and an existing config that is not a single-link regular file', () => {
    const r = rec()
    writeFileSync(join(root, 'notadir'), 'x')
    expect(() => writeReaderConfigFile(join(root, 'notadir', 'config.json'), '{}\n', { env, ...r })).toThrow(/not a real directory/)
    mkdirSync(join(root, 'hl'), { recursive: true })
    writeFileSync(join(root, 'hl', 'config.json'), '{}')
    linkSync(join(root, 'hl', 'config.json'), join(root, 'hl', 'second'))
    expect(() => handConfigToReader(join(root, 'hl', 'config.json'), { env, lchown: r.lchown })).toThrow(/single-link regular file/)
    expect(r.calls).toEqual([])
  })
  it('isTenantConfigPath picks the reader writer only for <data root>/<slug>/config.json', () => {
    expect(isTenantConfigPath(path, env)).toBe(true)
    expect(isTenantConfigPath(join(root, 'config.json'), env)).toBe(false)
    expect(isTenantConfigPath(join(tmpdir(), 'elsewhere', 'config.json'), env)).toBe(false)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
})
