import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatEdgeSyncReport, syncTenantRouters, type EdgeSyncTenant } from '../src/sync.js'
import { deps } from './helpers.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edge-sync-'))
  writeFileSync(join(dir, 'active.yml'), 'http: {}\n')
})

const t = (slug: string, hosts: string[], status: EdgeSyncTenant['status'] = 'active'): EdgeSyncTenant => ({
  slug,
  status,
  domains: hosts.map((host) => ({ host })),
})
const sync = (tenants: EdgeSyncTenant[], extra: Record<string, unknown> = {}) =>
  syncTenantRouters({ tenants, dynamicDir: dir, ...deps, ...extra })
const listing = () => readdirSync(dir).sort()

describe('syncTenantRouters — TDD 5', () => {
  it('emits one file per routable tenant and is a no-op on the second run', () => {
    const fleet = [t('acme', ['a.example.net']), t('beta', ['b.example.net', 'b2.example.net'])]
    const first = sync(fleet)
    expect(first.changed).toBe(true)
    expect(first.hostCount).toBe(3)
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml', 'tenant-beta.yml'])
    const second = sync(fleet)
    expect(second.changed).toBe(false)
    expect(second.rows.map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
  })

  it('reports and removes an orphan tenant-*.yml on a prune pass, never anything else', () => {
    sync([t('acme', ['a.example.net']), t('gone', ['g.example.net'])])
    writeFileSync(join(dir, 'tls.yml'), 'tls: {}\n')
    writeFileSync(join(dir, '.tenant-gone.yml.1.ab.tmp'), 'partial')
    const r = sync([t('acme', ['a.example.net'])], { prune: true })
    expect(r.orphans).toEqual(['tenant-gone.yml'])
    expect(r.changed).toBe(true)
    expect(listing()).toEqual(['.tenant-gone.yml.1.ab.tmp', 'active.yml', 'tenant-acme.yml', 'tls.yml'])
  })

  it('without prune an orphan is left in place and not reported', () => {
    sync([t('gone', ['g.example.net'])])
    const r = sync([t('acme', ['a.example.net'])])
    expect(r.orphans).toEqual([])
    expect(listing()).toContain('tenant-gone.yml')
  })

  it.each(['provisioning', 'deleting', 'deleted'] as const)('a %s tenant is dark at the edge: its file is removed', (status) => {
    sync([t('acme', ['a.example.net'])])
    const r = sync([t('acme', ['a.example.net'], status)])
    expect(r.rows[0]).toMatchObject({ routable: false, action: 'removed', hosts: [], dark: false })
    expect(listing()).toEqual(['active.yml'])
  })

  it('a suspended tenant keeps its router (the app serves it the branded 503)', () => {
    const r = sync([t('acme', ['a.example.net'], 'suspended')])
    expect(r.rows[0]).toMatchObject({ routable: true, action: 'written' })
  })

  it('a routable tenant with no surviving host is flagged dark', () => {
    const r = sync([t('acme', ['www.example.org'])])
    expect(r.rows[0]).toMatchObject({ routable: true, action: 'absent', dark: true })
    expect(r.rows[0]!.skipped.map((s) => s.code)).toEqual(['reserved'])
    expect(formatEdgeSyncReport(r).join('\n')).toMatch(/answers NOWHERE/)
  })

  it('refuses ONE host under TWO tenants and writes NEITHER file', () => {
    expect(() => sync([t('acme', ['shared.example.net']), t('beta', ['SHARED.example.net.'])])).toThrow(
      /shared\.example\.net.*BOTH "acme" and "beta"/,
    )
    expect(listing()).toEqual(['active.yml'])
  })

  it('the two-tenant refusal fires before a pre-existing file is touched', () => {
    sync([t('acme', ['a.example.net'])])
    const before = readFileSync(join(dir, 'tenant-acme.yml'), 'utf8')
    expect(() => sync([t('acme', ['a.example.net', 'x.example.net']), t('beta', ['x.example.net'], 'deleted')])).toThrow(/BOTH/)
    expect(readFileSync(join(dir, 'tenant-acme.yml'), 'utf8')).toBe(before)
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml'])
  })

  it('refuses reserved hosts: they never get a router', () => {
    const r = sync([t('acme', ['example.org', 'control.example.org', 'a.example.net'])])
    expect(r.rows[0]!.hosts).toEqual(['a.example.net'])
    expect(r.rows[0]!.skipped.map((s) => [s.host, s.code])).toEqual([
      ['example.org', 'reserved'],
      ['control.example.org', 'reserved'],
    ])
    expect(readFileSync(join(dir, 'tenant-acme.yml'), 'utf8')).not.toMatch(/control\.example\.org|Host\(`example\.org`\)/)
  })

  it('refuses two tenants whose router or middleware NAMES collide (a#1 vs a-1#0), writing neither', () => {
    expect(() => sync([t('a', ['x.example.net', 'y.example.net']), t('a-1', ['z.example.net'])])).toThrow(
      /tenant-a-1.*"a".*"a-1"|"a-1".*"a"/,
    )
    expect(listing()).toEqual(['active.yml'])
  })

  it('refuses a duplicate slug, an invalid slug and prune over an empty fleet', () => {
    expect(() => sync([t('acme', ['a.example.net']), t('acme', ['b.example.net'])])).toThrow(/twice/)
    expect(() => sync([t('../x', ['a.example.net'])])).toThrow(/invalid slug/)
    expect(() => sync([], { prune: true })).toThrow(/EMPTY/)
    expect(listing()).toEqual(['active.yml'])
  })

  it('emitOnly writes one tenant but still sees the whole fleet\'s claims', () => {
    const fleet = [t('acme', ['a.example.net']), t('beta', ['b.example.net'])]
    const r = sync(fleet, { emitOnly: ['acme'] })
    expect(r.rows.map((x) => x.slug)).toEqual(['acme'])
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml'])
    expect(() => sync([t('acme', ['b.example.net']), t('beta', ['b.example.net'])], { emitOnly: ['acme'] })).toThrow(/BOTH/)
    expect(() => sync(fleet, { emitOnly: ['nope'] })).toThrow(/not in the tenant list/)
    expect(() => sync(fleet, { emitOnly: ['acme'], prune: true })).toThrow(/mutually exclusive/)
  })

  it('dryRun reports everything and writes nothing', () => {
    writeFileSync(join(dir, 'tenant-gone.yml'), 'x')
    const r = sync([t('acme', ['a.example.net'])], { dryRun: true, prune: true })
    expect(r.rows[0]!.action).toBe('written')
    expect(r.orphans).toEqual(['tenant-gone.yml'])
    expect(listing()).toEqual(['active.yml', 'tenant-gone.yml'])
  })

  it('throws on an unknown status instead of deleting a live tenant\'s file', () => {
    sync([t('acme', ['a.example.net'])])
    expect(() => sync([{ slug: 'acme', status: 'Active' as never, domains: [{ host: 'a.example.net' }] }])).toThrow(/unknown status/)
    expect(listing()).toEqual(['active.yml', 'tenant-acme.yml'])
  })

  it('names the tenant whose domains are not an array', () => {
    expect(() => sync([{ slug: 'acme', status: 'active', domains: null as never }])).toThrow(/tenant "acme" domains must be an array/)
  })

  it('a SINGLE-tenant pass still refuses names already declared by another tenant\'s file on disk', () => {
    sync([t('a-1', ['z.example.net'])])
    const before = readFileSync(join(dir, 'tenant-a-1.yml'), 'utf8')
    expect(() => sync([t('a', ['x.example.net', 'y.example.net'])])).toThrow(/tenant-a-1" is claimed by BOTH "a" and "a-1"/)
    expect(listing()).toEqual(['active.yml', 'tenant-a-1.yml'])
    expect(readFileSync(join(dir, 'tenant-a-1.yml'), 'utf8')).toBe(before)
  })

  it('a SINGLE-tenant pass refuses a host another tenant\'s file on disk already routes', () => {
    sync([t('beta', ['shared.example.net'])])
    expect(() => sync([t('acme', ['Shared.example.net'])])).toThrow(/shared\.example\.net" is claimed by BOTH "acme" and "beta"/)
    expect(listing()).toEqual(['active.yml', 'tenant-beta.yml'])
  })

  it('one bad registry row (an IP literal, localhost) is skipped and reported, and the fleet still syncs', () => {
    const r = sync([t('acme', ['203.0.113.5', 'a.example.net']), t('beta', ['b.example.net'])])
    expect(r.rows.map((x) => x.action)).toEqual(['written', 'written'])
    expect(r.rows[0]!.skipped.map((x) => [x.host, x.code])).toEqual([['203.0.113.5', 'invalid-host']])
  })
})
