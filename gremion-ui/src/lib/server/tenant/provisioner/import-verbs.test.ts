// TASK-031: the import verbs' engine contract. The live half (Keycloak, the
// customer database) is test/host/integration/member-import-proof.sh.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IMPORT_VERBS, importVerb, readVertical, resultLine, type ImportVerbContext } from '../../../../../scripts/tenant-provision-import'

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
