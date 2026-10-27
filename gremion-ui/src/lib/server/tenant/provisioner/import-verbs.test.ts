// TASK-031: the import verbs' engine contract. The live half (Keycloak, the
// customer database) is test/host/integration/member-import-proof.sh.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportApplyError, type MemberImportTarget } from '@gremion/member-import'
import { IMPORT_VERBS, importFailure, importVerb, readVertical, resultLine, runImport, type ImportVerbContext } from '../../../../../scripts/tenant-provision-import'
import type { OrgStore } from './member-import-adapters'

const FIXTURE = join(process.cwd(), '..', 'packages', 'member-import', 'test', 'fixtures', 'verticals', 'fixture')
const tmp: string[] = []
function verticalsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'verticals-'))
  tmp.push(root)
  cpSync(FIXTURE, join(root, 'fixture'), { recursive: true })
  return root
}
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.GREMION_VERTICALS_DIR
  process.exitCode = 0
})

const ctxFor = (flags: Record<string, string>, positional: string[] = ['acme']): ImportVerbContext => ({
  withLive: vi.fn(async () => {
    throw new Error('withLive must not be reached')
  }),
  provisionerKc: vi.fn() as never,
  writeConfigFile: vi.fn(),
  readStdin: vi.fn(() => ''),
  flag: (n) => flags[n],
  reqFlag: (n) => {
    const v = flags[n]
    if (!v) throw new Error(`${n} is required`)
    return v
  },
  positional: (i = 0) => positional[i],
  usage: (m) => new Error(m),
  log: vi.fn(),
})

describe('import verbs', () => {
  it('serves exactly the three verbs', () => {
    expect([...IMPORT_VERBS].sort()).toEqual(['import-apply', 'import-validate', 'seed-vertical'])
  })

  it('the list is read from STDIN only: no flag, argv or env carries it', () => {
    const src = readFileSync('scripts/tenant-provision-import.ts', 'utf8')
    expect(src).not.toMatch(/--list|--file|--csv|--members/)
    expect(src).not.toMatch(/process\.argv|process\.env\.(?!GREMION_VERTICALS_DIR)/)
    expect(src).toMatch(/ctx\.readStdin\(\)/)
    const wired = readFileSync('scripts/tenant-provision.ts', 'utf8')
    expect(wired).toMatch(/readStdin: \(\) => readFileSync\(0, 'utf8'\)/)
  })

  it('apply demands an explicit validated sha256 (a usage error before any connection)', async () => {
    process.env.GREMION_VERTICALS_DIR = verticalsRoot()
    const ctx = ctxFor({ '--vertical': 'fixture' })
    await expect(importVerb('import-apply', ctx)).rejects.toThrow(/--expect-sha256/)
    await expect(importVerb('import-apply', ctxFor({ '--vertical': 'fixture', '--expect-sha256': 'abc' }))).rejects.toThrow(/64 lowercase hex/)
    expect(ctx.withLive).not.toHaveBeenCalled()
  })

  it('an unknown or broken vertical is a failed result (exit 1), never a partial run', async () => {
    process.env.GREMION_VERTICALS_DIR = verticalsRoot()
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const ctx = ctxFor({ '--vertical': 'nonexistent' })
      await importVerb('import-validate', ctx)
      expect(process.exitCode).toBe(1)
      expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ status: 'failed' })
      expect(ctx.withLive).not.toHaveBeenCalled()
    } finally {
      out.mockRestore()
    }
  })

  it('readVertical loads through the vertical directory and refuses a path-like id', () => {
    const root = verticalsRoot()
    expect(readVertical('fixture', root).manifest.id).toBe('fixture')
    expect(() => readVertical('../fixture', root)).toThrow(/a-z0-9/)
  })

  it('the result line names the customer kernel database (the host takes its dump before the apply), and never an e-mail', () => {
    const id = '0190f7a0-1b2c-7d3e-8f4a-5b6c7d8e9f01'
    const line = resultLine({ status: 'validated', sha256: 'a'.repeat(64), counts: { created: 0, linked_existing: 0, unchanged: 0, rejected: 0, accounts_created: 0, invites_sent: 0 }, rows: [] }, id)
    expect(line).toMatchObject({ status: 'validated', database: 't_0190f7a01b2c7d3e8f4a5b6c7d8e9f01__kernel' })
    expect(JSON.stringify(line)).not.toMatch(/@/)
  })
})

// TASK-031 fix round (house review MED 3, LOW): what the import path may print,
// and the executor lease heartbeat.
describe('runImport: errors and the lease heartbeat', () => {
  const LEAK = 'Keycloak Admin API error: 409 on POST /admin/realms/r/users?email=anna%40x.example: {"errorMessage":"User anna@x.example exists"}'
  const HEADER = 'name,email,body,role\n'
  const vertical = () => readVertical('fixture', verticalsRoot())
  const store = (over: Partial<OrgStore> = {}): OrgStore =>
    ({
      listBodies: async () => [{ id: 'b-assembly', name: 'Assembly' }],
      membership: async () => null,
      addMembership: async () => {},
      rearm: async () => {},
      ...over,
    }) as OrgStore
  const accounts = (over: Partial<Pick<MemberImportTarget, 'findUserId' | 'ensureAccount'>> = {}) => ({
    findUserId: async () => null,
    ensureAccount: async () => ({ userId: 'u-1', created: true, invited: true }),
    ...over,
  })
  const list = HEADER + 'Anna Berger,anna@x.example,Assembly,\n'

  it('apply with the validated sha: the 409 becomes "row 2: account_failed (http 409)"', async () => {
    const v = await runImport('import-validate', list, vertical(), undefined, { store: store(), accounts: accounts() })
    const r = await runImport('import-apply', list, vertical(), v.sha256, {
      store: store(),
      accounts: accounts({
        ensureAccount: async () => {
          throw new Error(LEAK)
        },
      }),
    })
    expect(r).toMatchObject({ status: 'failed', error: 'row 2: account_failed (http 409)' })
    expect(JSON.stringify(r)).not.toMatch(/@|%40|anna/i)
  })

  it('an empty find after a failed create (the lookup is the failing call) is also row + code', async () => {
    const v = await runImport('import-validate', list, vertical(), undefined, { store: store(), accounts: accounts() })
    const r = await runImport('import-apply', list, vertical(), v.sha256, {
      store: store(),
      accounts: accounts({
        findUserId: async () => {
          throw new Error(`GET /admin/realms/r/users?email=anna%40x.example&exact=true: 500`)
        },
      }),
    })
    expect(r).toMatchObject({ status: 'failed', error: 'row 2: account_lookup_failed' })
    expect(JSON.stringify(r)).not.toMatch(/@|%40|anna/i)
  })

  it('an unexpected error of the store is redacted, not rethrown with its message', async () => {
    const r = await runImport('import-validate', list, vertical(), undefined, {
      store: store({
        listBodies: async () => {
          throw new Error('connection to anna@x.example refused (?email=anna%40x.example)')
        },
      }),
      accounts: accounts(),
    })
    expect(r.status).toBe('failed')
    expect(JSON.stringify(r)).not.toMatch(/@|%40|anna/i)
  })

  it('a headerless list is a rejected result that echoes no cell', async () => {
    const r = await runImport('import-validate', 'Anna Berger,anna@x.example,Assembly,member\n', vertical(), undefined, { store: store(), accounts: accounts() })
    expect(r.status).toBe('rejected')
    expect(JSON.stringify(r)).not.toMatch(/@|anna|berger/i)
  })

  it('importFailure maps the library errors and leaves nothing of an address', () => {
    expect(importFailure(new ImportApplyError(7, 'membership_failed'))).toMatchObject({ status: 'failed', error: 'row 7: membership_failed' })
    expect(importFailure(new Error('x@y.example'))).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(importFailure(new Error('x@y.example')))).not.toMatch(/@/)
  })

  it('the heartbeat (executor lease renewal) fires at least every 200 rows of an apply', async () => {
    const many = HEADER + Array.from({ length: 450 }, (_, i) => `Person ${i},p${i}@x.example,Assembly,`).join('\n') + '\n'
    const v = await runImport('import-validate', many, vertical(), undefined, { store: store(), accounts: accounts() })
    expect(v.status).toBe('validated')
    let beats = 0
    const r = await runImport('import-apply', many, vertical(), v.sha256, {
      store: store(),
      accounts: accounts({ ensureAccount: async () => ({ userId: `u-${beats}`, created: true, invited: true }) }),
      onProgress: () => void beats++,
    })
    expect(r.status).toBe('applied')
    expect(beats).toBeGreaterThanOrEqual(4)
  })

  it('the container announces the beat in the executor step-marker protocol (stderr, own line) and the verb forwards it', () => {
    const src = readFileSync('scripts/tenant-provision-import.ts', 'utf8')
    expect(src).toMatch(/onProgress: \(\) => ctx\.heartbeat\?\.\(\)/)
    const wired = readFileSync('scripts/tenant-provision.ts', 'utf8')
    expect(wired).toMatch(/heartbeat: \(\) => process\.stderr\.write\('@@executor-step import-apply\\n'\)/)
  })

  it('the customer token comes from tokenFor, not a hand-rolled slug replace', () => {
    const src = readFileSync('scripts/tenant-provision-import.ts', 'utf8')
    expect(src).toMatch(/tokenFor\(row\.slug\)/)
    expect(src).not.toMatch(/slug\.replace\(/)
  })
})
