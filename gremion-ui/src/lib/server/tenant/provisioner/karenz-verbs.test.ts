// Module Karenz, phase 2 Task 4: the `karenz-run` and `karenz-status` verbs of the
// tenant-create one-shot, the delete refusal that names the Karenz, and the export
// of a customer whose module database is blocked. The day-30 engine itself is
// proven in packages/tenant-store (lifecycle-karenz); this is the verbs' contract:
// ONE JSON line on stdout, the exit code, no stray argument, the deletion switch.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KARENZ_USAGE, KARENZ_VERBS, karenzVerb, liveModuleDatabasesRefusal, type KarenzVerbContext } from '../../../../../scripts/tenant-provision-karenz'
import { exportVerb, type ExportVerbContext } from '../../../../../scripts/tenant-provision-export'

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

const ID = '11111111-1111-7111-8111-111111111111'

function finalizeResult(over: Record<string, unknown> = {}) {
  return { due: 0, finalized: 0, kept: 0, dryRun: true, errors: [], orphanedExports: [], ...over }
}

function ctx(over: Partial<KarenzVerbContext> & { finalizeDue?: (o: { finalDeletion: boolean; deadlineMs: number }) => Promise<unknown>; env?: Record<string, string | undefined> } = {}, args: string[] = []) {
  const { finalizeDue, ...rest } = over
  const fd = vi.fn(finalizeDue ?? (async () => finalizeResult()))
  const c: KarenzVerbContext = {
    args,
    env: {},
    withLive: async (_o, fn) => fn({ modules: { finalizeDue: fd } } as never),
    openPlatform: () => {
      throw new Error('no platform in this test')
    },
    customerIdForSlug: async () => null,
    exportDirMounted: () => true,
    usage: (m) => new Error(`USAGE ${m}`),
    log: vi.fn(),
    ...rest,
  }
  return { c, fd }
}

function stdout() {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return () => out.mock.calls.map((x) => String(x[0]))
}

describe('karenz verbs', () => {
  it('are the two verbs of the file and are in the usage text', () => {
    expect([...KARENZ_VERBS].sort()).toEqual(['karenz-run', 'karenz-status'])
    expect(KARENZ_USAGE).toContain('karenz-run')
    expect(KARENZ_USAGE).toContain('karenz-status <slug>')
  })
})

describe('karenz-run', () => {
  it('karenz-run with deletion off prints deletion off, lists orphanedExports and exits 0 even when rows are due', async () => {
    const lines = stdout()
    const { c, fd } = ctx({ finalizeDue: async () => finalizeResult({ due: 3, dryRun: true, orphanedExports: ['/exports/t/votes/old.dump'] }), exportDirMounted: () => false })
    await karenzVerb('karenz-run', c)
    expect(lines()).toHaveLength(1)
    const line = lines()[0]!
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ verb: 'karenz-run', deletion: 'off', due: 3, finalized: 0, kept: 0, orphanedExports: ['/exports/t/votes/old.dump'], errors: [] })
    expect(process.exitCode ?? 0).toBe(0)
    // the dry run reaches the engine with the switch off, and never needed the export volume to be a mount
    expect(fd).toHaveBeenCalledTimes(1)
    expect(fd.mock.calls[0]![0]).toMatchObject({ finalDeletion: false })
    expect(typeof fd.mock.calls[0]![0].deadlineMs).toBe('number')
  })

  it('anything but the exact string on keeps the deletion off (ON, true, 1, empty)', async () => {
    stdout()
    for (const v of ['ON', 'true', '1', '', 'off', undefined]) {
      const { c, fd } = ctx({ env: { KARENZ_FINAL_DELETION: v } })
      await karenzVerb('karenz-run', c)
      expect(fd.mock.calls[0]![0], JSON.stringify(v)).toMatchObject({ finalDeletion: false })
    }
  })

  it('KARENZ_FINAL_DELETION=on runs live, prints deletion on and needs the export directory to be a mount', async () => {
    const lines = stdout()
    const { c, fd } = ctx({ env: { KARENZ_FINAL_DELETION: 'on', TENANT_EXPORT_DIR: '/exports' }, finalizeDue: async () => finalizeResult({ due: 1, finalized: 1, dryRun: false }) })
    await karenzVerb('karenz-run', c)
    expect(JSON.parse(lines()[0]!)).toMatchObject({ verb: 'karenz-run', deletion: 'on', due: 1, finalized: 1 })
    expect(fd.mock.calls[0]![0]).toMatchObject({ finalDeletion: true })
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('deletion on with an export directory that is not a mount is a usage error and nothing runs', async () => {
    const lines = stdout()
    const { c, fd } = ctx({ env: { KARENZ_FINAL_DELETION: 'on', TENANT_EXPORT_DIR: '/exports' }, exportDirMounted: () => false })
    await expect(karenzVerb('karenz-run', c)).rejects.toThrow(/USAGE .*TENANT_EXPORT_DIR/)
    expect(fd).not.toHaveBeenCalled()
    expect(lines()).toEqual([])
  })

  it('the refusal names the seam\'s reason, not only that the directory is "not mounted"', async () => {
    stdout()
    // a stand-in check carries only a boolean, so the message gives the generic reason
    const stub = ctx({ env: { KARENZ_FINAL_DELETION: 'on', TENANT_EXPORT_DIR: '/exports' }, exportDirMounted: () => false })
    await expect(karenzVerb('karenz-run', stub.c)).rejects.toThrow(/USAGE .*\(it is not a mounted volume\)$/)
    // the real check (no stand-in) puts the seam's own reason in the message; which one depends on the host
    // (a Linux host: "not a mount point"; a host without a mount table: the table is named), never nothing
    const real = ctx({ env: { KARENZ_FINAL_DELETION: 'on', TENANT_EXPORT_DIR: '/exports' }, exportDirMounted: undefined })
    await expect(karenzVerb('karenz-run', real.c)).rejects.toThrow(/USAGE .*nothing was touched \(.*(mount point|mount table).*\)$/)
    expect(real.fd).not.toHaveBeenCalled()
  })

  it('karenz-run exits 1 and lists the error when finalizeDue returns an error', async () => {
    const lines = stdout()
    const err = { karenzId: '0198a1b2-0000-7000-8000-000000000001', moduleKey: 'votes', message: 'EXPORT_MISSING: the export is missing' }
    const { c } = ctx({ env: { KARENZ_FINAL_DELETION: 'on', TENANT_EXPORT_DIR: '/exports' }, finalizeDue: async () => finalizeResult({ due: 2, finalized: 1, dryRun: false, errors: [err] }) })
    await karenzVerb('karenz-run', c)
    expect(lines()).toHaveLength(1)
    expect(JSON.parse(lines()[0]!)).toMatchObject({ verb: 'karenz-run', deletion: 'on', due: 2, finalized: 1, errors: [err] })
    expect(process.exitCode).toBe(1)
    expect(vi.mocked(c.log).mock.calls.flat().join('\n')).toContain('EXPORT_MISSING')
  })

  it('a dry run that carries an error is still exit 1 (an error is never a success)', async () => {
    stdout()
    const { c } = ctx({ finalizeDue: async () => finalizeResult({ errors: [{ karenzId: 'k', moduleKey: 'votes', message: 'boom' }] }) })
    await karenzVerb('karenz-run', c)
    expect(process.exitCode).toBe(1)
  })

  it('karenz-run takes no argument (exit 2)', async () => {
    const { c, fd } = ctx({}, ['--all'])
    await expect(karenzVerb('karenz-run', c)).rejects.toThrow(/USAGE karenz-run takes no argument/)
    expect(fd).not.toHaveBeenCalled()
  })

  it('a modules port without finalizeDue fails loudly instead of reporting an empty run', async () => {
    const lines = stdout()
    const { c } = ctx({ withLive: async (_o, fn) => fn({ modules: {} } as never) })
    await expect(karenzVerb('karenz-run', c)).rejects.toThrow(/finalizeDue/)
    expect(lines()).toEqual([])
  })
})

describe('karenz-status', () => {
  const row = {
    karenz_id: '0198a1b2-0000-7000-8000-000000000001',
    module_key: 'votes',
    state: 'open',
    switched_off_at: new Date('2026-10-01T10:00:00Z'),
    final_at: new Date('2026-10-31T10:00:00Z'),
    actor_kind: 'person',
    actor_id: '5b8e0a52-2f9f-4b46-9e3a-0b5c7f1a2d33',
    export_path: '/exports/t/votes/x.dump',
    export_deleted_at: null,
    export_kept_until: null,
    final_mode: 'dry',
    platform_done_at: null,
    tenant_done_at: null,
    retained_ok_at: null,
  }

  it('karenz-status refuses an unknown slug', async () => {
    const { c } = ctx({ customerIdForSlug: async () => null }, ['nobody'])
    await expect(karenzVerb('karenz-status', c)).rejects.toThrow(/USAGE unknown customer "nobody"/)
  })

  it('karenz-status refuses a missing or malformed slug and a second argument, before any connection', async () => {
    await expect(karenzVerb('karenz-status', ctx({}, []).c)).rejects.toThrow(/USAGE karenz-status requires <slug>/)
    await expect(karenzVerb('karenz-status', ctx({}, ['Bad Slug']).c)).rejects.toThrow(/USAGE/)
    await expect(karenzVerb('karenz-status', ctx({}, ['acme', 'extra']).c)).rejects.toThrow(/USAGE/)
  })

  it('prints ONE JSON line with the live and recent rows, the operator view including the actor, and closes the pool', async () => {
    const lines = stdout()
    const ended: string[] = []
    const queries: string[] = []
    const platform = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(strings.join('?'))
        expect(values).toContain(ID)
        return [row]
      },
      { end: async () => void ended.push('platform') },
    )
    const { c } = ctx({ customerIdForSlug: async () => ID, openPlatform: () => platform as never }, ['acme'])
    await karenzVerb('karenz-status', c)
    expect(lines()).toHaveLength(1)
    const j = JSON.parse(lines()[0]!)
    expect(j).toMatchObject({ verb: 'karenz-status', slug: 'acme' })
    expect(j.rows).toHaveLength(1)
    expect(j.rows[0]).toMatchObject({ moduleKey: 'votes', state: 'open', actorKind: 'person', actorId: row.actor_id, finalMode: 'dry' })
    expect(j.rows[0].finalAt).toBe('2026-10-31T10:00:00.000Z')
    expect(ended).toEqual(['platform'])
    // live rows and the recent closed ones, newest first, and a bounded list
    expect(queries[0]).toMatch(/plt\.module_karenz/)
    expect(queries[0]).toMatch(/ORDER BY/i)
    expect(queries[0]).toMatch(/LIMIT/i)
  })
})

describe('the delete refusal names the Karenz', () => {
  const blocked = [{ module_key: 'votes', state: 'blocked', final_at: new Date('2026-11-30T10:00:00Z') }]

  it('the delete refusal text names Karenz and not "disable them first"', () => {
    const text = liveModuleDatabasesRefusal('acme', blocked)
    expect(text).toContain('Karenz')
    expect(text).toContain('acme')
    expect(text).toContain('votes')
    expect(text).toContain('2026-11-30')
    expect(text).not.toMatch(/disable them first/)
  })

  it('an enabled module database is told to be switched off and waited out, a blocked one names its end', () => {
    const text = liveModuleDatabasesRefusal('acme', [{ module_key: 'finance', state: 'enabled', final_at: null }, ...blocked])
    expect(text).toMatch(/finance/)
    expect(text).toMatch(/blocked/)
    expect(text).toContain('Karenz')
    expect(text).not.toMatch(/disable them first/)
  })

  it('a blocked row without a live Karenz clock is named as such, never as a date', () => {
    const text = liveModuleDatabasesRefusal('acme', [{ module_key: 'votes', state: 'blocked', final_at: null }])
    expect(text).toContain('votes')
    expect(text).not.toMatch(/Invalid|NaN|null/)
  })

  it('tenant-provision.ts delete no longer carries the old wording and uses the shared refusal', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'tenant-provision.ts'), 'utf8')
    expect(src).not.toContain('disable them first')
    expect(src).toContain('liveModuleDatabasesRefusal(')
  })

  it('main() routes both karenz verbs to karenzVerb with the context it needs (the CLI cannot say "unknown verb")', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'tenant-provision.ts'), 'utf8')
    const main = src.slice(src.indexOf('async function main()'))
    const arm = main.match(/case 'karenz-run':\s*case 'karenz-status':[\s\S]*?(?=\n    (?:case |default:))/)
    expect(arm, 'a case arm for karenz-run and karenz-status in main()').not.toBeNull()
    const body = arm![0]
    expect(body).toContain('KARENZ_VERBS.has(verb)')
    expect(body).toContain('return karenzVerb(verb')
    expect(body).toContain('withLive')
    expect(body).toContain('openPlatform: openPlatformPool')
    expect(body).toContain('customerIdForSlug')
    expect(body).toContain('process.argv.slice(3)')
  })
})

describe('export of a customer whose module database is blocked', () => {
  function exportCtx(state: string): ExportVerbContext {
    const rows = [{ module_key: 'finance', state }]
    return {
      catalogue: () =>
        [{ id: 'finance', moduleJson: { runtime: { export: { kind: 'pg_dump', retentionProfile: 'rp-fin-module-data' }, database: { postgresService: 'finance-postgres' } } } }] as never,
      customerIdForSlug: async () => ID,
      openPlatform: () => Object.assign(async () => rows, { end: async () => undefined }) as never,
      kernelUrl: () => {
        throw new Error('KERNEL-URL-REQUESTED')
      },
      moduleUrl: (id) => {
        throw new Error(`MODULE-URL-REQUESTED ${id}`)
      },
      reqFlag: () => '/x',
      positional: (i = 0) => ['acme'][i],
      usage: (m) => new Error(`USAGE ${m}`),
      log: () => {},
    }
  }

  it('the export of a customer whose module database is blocked includes that database (state blocked is treated as enabled, not transitional)', async () => {
    // the module's server url is asked for only for a module that is exported: it comes first, before the kernel's
    await expect(exportVerb('export', exportCtx('blocked'))).rejects.toThrow(/MODULE-URL-REQUESTED finance/)
  })

  it('the control: an enabled module database is included the same way', async () => {
    await expect(exportVerb('export', exportCtx('enabled'))).rejects.toThrow(/MODULE-URL-REQUESTED finance/)
  })

  it('a blocked database is not reported as a transitional state', async () => {
    await expect(exportVerb('export', exportCtx('blocked'))).rejects.not.toThrow(/changing state/)
  })
})
