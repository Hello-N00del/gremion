import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { emitTenantRouterFile, removeTenantRouterFile } from '../src/emit.ts'
import { deps } from './helpers.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edge-emit-'))
  writeFileSync(join(dir, 'active.yml'), 'http: {}\n')
})

const emit = (hosts: string[], extra: Record<string, unknown> = {}) =>
  emitTenantRouterFile({ slug: 'acme', domains: hosts.map((host) => ({ host })), dynamicDir: dir, ...deps, ...extra })

const listing = () => readdirSync(dir).sort()

describe('emitTenantRouterFile — TDD 4', () => {
  it('writes tenant-<slug>.yml once, 0644, and leaves every other file alone', () => {
    const r = emit(['a.example.net'])
    expect(r.action).toBe('written')
    expect(r.path).toBe(join(dir, 'tenant-acme.yml'))
    expect(readFileSync(r.path, 'utf8')).toBe(r.yaml)
    expect(statSync(r.path).mode & 0o777).toBe(0o644)
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml'])
    expect(readFileSync(join(dir, 'active.yml'), 'utf8')).toBe('http: {}\n')
  })

  it('an identical rewrite reports unchanged and does not touch the file (mtime unchanged)', () => {
    const first = emit(['a.example.net'])
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(first.path, past, past)
    const before = statSync(first.path).mtimeMs
    const again = emit(['a.example.net'])
    expect(again.action).toBe('unchanged')
    expect(statSync(first.path).mtimeMs).toBe(before)
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml'])
  })

  it('a changed document is rewritten', () => {
    emit(['a.example.net'])
    const r = emit(['a.example.net', 'b.example.net'])
    expect(r.action).toBe('written')
    expect(readFileSync(r.path, 'utf8')).toContain('b.example.net')
  })

  it('leaves NO partial file and the old content intact when the rename fails', () => {
    const first = emit(['a.example.net'])
    const io = {
      renameSync: () => {
        throw Object.assign(new Error('EXDEV simulated'), { code: 'EXDEV' })
      },
    }
    expect(() => emit(['a.example.net', 'b.example.net'], { io })).toThrow(/EXDEV simulated/)
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml'])
    expect(readFileSync(first.path, 'utf8')).toBe(first.yaml)
  })

  it('leaves NO partial file when the temp write itself fails half-way', () => {
    const io = {
      writeFileSync: (p: string, data: string, o: object) => {
        writeFileSync(p, data.slice(0, 10), o)
        throw new Error('ENOSPC simulated')
      },
    }
    expect(() => emit(['a.example.net'], { io })).toThrow(/ENOSPC simulated/)
    expect(listing()).toEqual(['active.yml'])
  })

  it('removed: a tenant with no routable host loses its stale file', () => {
    emit(['a.example.net'])
    const r = emit(['example.org']) // reserved -> nothing survives
    expect(r.action).toBe('removed')
    expect(r.yaml).toBeNull()
    expect(listing()).toEqual(['active.yml'])
  })

  it('absent: nothing to write and nothing to delete', () => {
    const r = emit([])
    expect(r.action).toBe('absent')
    expect(listing()).toEqual(['active.yml'])
  })

  it('dryRun reports the action and touches nothing', () => {
    expect(emit(['a.example.net'], { dryRun: true }).action).toBe('written')
    expect(listing()).toEqual(['active.yml'])
    emit(['a.example.net'])
    expect(emit([], { dryRun: true }).action).toBe('removed')
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml'])
  })

  it('refuses a missing directory instead of creating one', () => {
    const missing = join(dir, 'nope')
    expect(() => emit(['a.example.net'], { dynamicDir: missing })).toThrow(/does not exist|not a directory/)
    expect(existsSync(missing)).toBe(false)
  })

  it('refuses to write through a symlink planted at the target name', () => {
    const outside = mkdtempSync(join(tmpdir(), 'edge-outside-'))
    writeFileSync(join(outside, 'victim'), 'keep\n')
    symlinkSync(join(outside, 'victim'), join(dir, 'tenant-acme.yml'))
    expect(() => emit(['a.example.net'])).toThrow(/not a regular file/)
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('keep\n')
    expect(lstatSync(join(dir, 'tenant-acme.yml')).isSymbolicLink()).toBe(true)
  })

  it.each(['../evil', '..', 'a/../../x', 'x\u0000'])('a traversal slug %j never reaches the filesystem', (slug) => {
    expect(() =>
      emitTenantRouterFile({ slug, domains: [{ host: 'a.example.net' }], dynamicDir: dir, ...deps }),
    ).toThrow(/invalid slug/)
    expect(listing()).toEqual(['active.yml'])
  })
})

describe('removeTenantRouterFile', () => {
  it('is idempotent and removes only its own file', () => {
    emit(['a.example.net'])
    expect(removeTenantRouterFile('acme', dir)).toBe(true)
    expect(removeTenantRouterFile('acme', dir)).toBe(false)
    expect(listing()).toEqual(['active.yml'])
    expect(() => removeTenantRouterFile('../active', dir)).toThrow(/invalid slug/)
  })
})
