import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Sql } from '@gremion/db'
import { schemaGate } from './schema-gate.js'

const A = '01928f4e-8c3b-7a51-9d2e-3f4a5b6c7d8e'
const B = '01928f4e-8c3b-7a51-9d2e-3f4a5b6c7d8f'
const H = 'a'.repeat(64)
const dir = mkdtempSync(join(tmpdir(), 't020-gate-'))
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ '001_a.sql': H, '002_b.sql': H }))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A fake database whose ledger holds `files`; records the begin() mode. */
function fakeDb(files: string[] | Error, modes: string[] = [], queries: string[] = []): Sql {
  const answer = (text: string) => {
    queries.push(text)
    return Promise.resolve(text.includes('to_regclass') ? [{ present: true }] : (files as string[]).map((f) => ({ filename: f, sha256: H })))
  }
  // TASK-077 G3(a): the ledger read names a validated ledger, so it goes through unsafe().
  const tx = Object.assign((strings: TemplateStringsArray) => answer(strings.join('?')), { unsafe: (q: string) => answer(q) }) as never
  return {
    begin: async (mode: string, cb: (t: unknown) => unknown) => {
      modes.push(mode)
      if (files instanceof Error) throw files
      return cb(tx)
    },
  } as never
}

describe('schemaGate', () => {
  it('checks in a read-only transaction', async () => {
    const modes: string[] = []
    const gate = schemaGate({ dir, openDb: async () => fakeDb(['001_a.sql', '002_b.sql'], modes), log: () => {} })
    expect(await gate.check(A)).toEqual({ ok: true })
    expect(modes).toEqual(['read only'])
  })

  it('caches per tenant: A current never answers for B behind', async () => {
    const dbs: Record<string, Sql> = { [A]: fakeDb(['001_a.sql', '002_b.sql']), [B]: fakeDb(['001_a.sql']) }
    const gate = schemaGate({ dir, openDb: async (t) => dbs[t]!, cacheTtlMs: 60_000, log: () => {} })
    expect(await gate.check(A)).toEqual({ ok: true })
    expect(await gate.check(B)).toEqual({ ok: false, reason: 'behind', retryAfterSeconds: 30 })
    expect(await gate.check(A)).toEqual({ ok: true })
  })

  it('a ledger that disagrees with the manifest is diverged, not current', async () => {
    const gate = schemaGate({ dir, openDb: async () => fakeDb(['001_a.sql', '002_b.sql', '003_gone.sql']), log: () => {} })
    expect(await gate.check(A)).toMatchObject({ ok: false, reason: 'diverged' })
  })

  it('a failed check is a 503 (unavailable) and is not cached', async () => {
    let db: Sql = fakeDb(new Error('connection refused'))
    const lines: string[] = []
    const gate = schemaGate({ dir, openDb: async () => db, cacheTtlMs: 60_000, log: (l) => lines.push(l) })
    expect(await gate.check(A)).toEqual({ ok: false, reason: 'unavailable', retryAfterSeconds: 30 })
    expect(lines.join('\n')).toMatch(/connection refused/)
    db = fakeDb(['001_a.sql', '002_b.sql'])
    expect(await gate.check(A)).toEqual({ ok: true })
  })

  it('refuses a tenant id that is not a UUIDv7 before touching any database', async () => {
    let opened = 0
    const gate = schemaGate({ dir, openDb: async () => (opened++, fakeDb([])), log: () => {} })
    await expect(gate.check('../x')).rejects.toThrow(/tenant id/)
    expect(opened).toBe(0)
  })

  it('guard answers 404 for an id that is not a UUIDv7, instead of throwing into the handler', async () => {
    const gate = schemaGate({ dir, openDb: async () => fakeDb([]), log: () => {} })
    let status = 0
    const res = { writeHead: (s: number) => ((status = s), res), end: () => res } as never
    await expect(gate.guard('../x', res)).resolves.toBe(false)
    expect(status).toBe(404)
  })

  it('fails at construction on an EMPTY manifest (every tenant would look current)', () => {
    const empty = mkdtempSync(join(tmpdir(), 't020-gate-empty-'))
    writeFileSync(join(empty, 'manifest.json'), '{}')
    expect(() => schemaGate({ dir: empty, openDb: async () => fakeDb([]) })).toThrow(/NO_MIGRATIONS/)
    rmSync(empty, { recursive: true, force: true })
  })

  it('fails at construction on a malformed manifest', () => {
    const bad = mkdtempSync(join(tmpdir(), 't020-gate-bad-'))
    writeFileSync(join(bad, 'manifest.json'), '[]')
    expect(() => schemaGate({ dir: bad, openDb: async () => fakeDb([]) })).toThrow(/MANIFEST_MALFORMED/)
    rmSync(bad, { recursive: true, force: true })
  })
})

// TASK-075 TDD 5 (G2): the serving colour survives the next release's expand.
type Row = { filename: string; sha256?: string; phase?: string | null; contract_after?: string | null }
function ledgerDb(rows: Row[]): Sql {
  const answer = (text: string) =>
    Promise.resolve(
      text.includes('to_regclass')
        ? [{ present: true }]
        : rows.map((r) => ({ filename: r.filename, sha256: r.sha256 ?? H, phase: r.phase ?? null, contract_after: r.contract_after ?? null })),
    )
  const tx = Object.assign((strings: TemplateStringsArray) => answer(strings.join('?')), { unsafe: (q: string) => answer(q) }) as never
  return { begin: async (_m: string, cb: (t: unknown) => unknown) => cb(tx) } as never
}

describe('schemaGate: state ahead (TASK-075, TRD-361)', () => {
  const R = 'dist-v1.4.0'
  const both: Row[] = [
    { filename: '001_a.sql', phase: 'expand' },
    { filename: '002_b.sql', phase: 'expand' },
  ]
  // null (not undefined, which a default parameter swallows) = a gate with no releaseRef
  const gate = (rows: Row[], lines: string[] = [], releaseRef: string | null = R) =>
    schemaGate({ dir, openDb: async () => ledgerDb(rows), log: (l) => lines.push(l), cacheTtlMs: 60_000, ...(releaseRef ? { releaseRef } : {}) })

  it('{1,2,3 expand} against manifest {1,2} is served, and logged once per TTL', async () => {
    const lines: string[] = []
    const g = gate([...both, { filename: '003_c.sql', phase: 'expand' }], lines)
    expect(await g.check(A)).toEqual({ ok: true })
    expect(await g.check(A)).toEqual({ ok: true })
    expect(lines).toEqual([expect.stringMatching(/schema ahead of this release \(dist-v1\.4\.0\): \[003_c\.sql\]/)])
  })

  it('a migrate row after the head is served too', async () => {
    expect(await gate([...both, { filename: '003_c.sql', phase: 'migrate' }]).check(A)).toEqual({ ok: true })
  })

  it('a contract whose contract_after <= R is served; > R is 503', async () => {
    expect(await gate([...both, { filename: '003_c.sql', phase: 'contract', contract_after: 'dist-v1.4.0' }]).check(A)).toEqual({ ok: true })
    expect(await gate([...both, { filename: '003_c.sql', phase: 'contract', contract_after: 'dist-v1.3.9' }]).check(A)).toEqual({ ok: true })
    expect(await gate([...both, { filename: '003_c.sql', phase: 'contract', contract_after: 'dist-v1.10.0' }]).check(A)).toMatchObject({ ok: false, reason: 'diverged' })
  })

  it('a contract row with no releaseRef on the gate is 503', async () => {
    expect(await gate([...both, { filename: '003_c.sql', phase: 'contract', contract_after: 'dist-v0.0.1' }], [], null).check(A)).toMatchObject({ ok: false, reason: 'diverged' })
  })

  it('{1,3 expand} against manifest {1,2,4}-shaped: an extra row below the head, or a pending file, is 503', async () => {
    // manifest {001, 002}: a row 000_x below the head
    expect(await gate([{ filename: '000_x.sql', phase: 'expand' }, ...both]).check(A)).toMatchObject({ ok: false, reason: 'diverged' })
    // 002 pending while 003 is applied
    expect(await gate([both[0]!, { filename: '003_c.sql', phase: 'expand' }]).check(A)).toMatchObject({ ok: false, reason: 'diverged' })
  })

  it('a hash mismatch is 503 even with rows ahead', async () => {
    expect(await gate([both[0]!, { filename: '002_b.sql', sha256: 'b'.repeat(64), phase: 'expand' }, { filename: '003_c.sql', phase: 'expand' }]).check(A)).toMatchObject({ ok: false, reason: 'diverged' })
  })

  it('a row ahead with no phase (a ledger predating the columns) is 503', async () => {
    expect(await gate([...both, { filename: '003_c.sql', phase: null }]).check(A)).toMatchObject({ ok: false, reason: 'diverged' })
  })
})

// TASK-077 G3: the ledger option and the union of dirs.
describe('schemaGate: ledger (G3 a) and dirs (G3 b)', () => {
  const unionRoot = mkdtempSync(join(tmpdir(), 't077-gate-union-'))
  const core = join(unionRoot, 'core')
  const bodies = join(unionRoot, 'bodies')
  const dup = join(unionRoot, 'dup')
  for (const d of [core, bodies, dup]) mkdirSync(d)
  writeFileSync(join(core, 'manifest.json'), JSON.stringify({ '0001_core.sql': H, '0003_core.sql': H }))
  writeFileSync(join(bodies, 'manifest.json'), JSON.stringify({ '0002_bodies.sql': H }))
  writeFileSync(join(dup, 'manifest.json'), JSON.stringify({ '0003_other.sql': H }))
  afterAll(() => rmSync(unionRoot, { recursive: true, force: true }))

  it('reads the ledger it is given, quoted, and the default when none is', async () => {
    const q1: string[] = []
    await schemaGate({ dir, ledger: 'idt.schema_migration', openDb: async () => fakeDb(['001_a.sql', '002_b.sql'], [], q1), log: () => {} }).check(A)
    expect(q1.some((q) => q.includes('FROM "idt"."schema_migration" m'))).toBe(true)
    expect(q1.some((q) => q.includes('schema_migrations'))).toBe(false)
    const q2: string[] = []
    await schemaGate({ dir, openDb: async () => fakeDb(['001_a.sql', '002_b.sql'], [], q2), log: () => {} }).check(A)
    expect(q2.some((q) => q.includes('FROM "public"."schema_migrations" m'))).toBe(true)
  })

  it.each([['idt'], ['idt.schema_migration; DROP TABLE x'], ['"idt".x'], ['IDT.x'], ['a.b.c']])('refuses ledger %j at construction', (ledger) => {
    expect(() => schemaGate({ dir, ledger, openDb: async () => fakeDb([]) })).toThrow(/schema\.table/)
  })

  it('a union of dirs is ONE manifest in number order: current only when every dir is applied', async () => {
    const dirs = [core, bodies]
    expect(await schemaGate({ dirs, openDb: async () => fakeDb(['0001_core.sql', '0002_bodies.sql', '0003_core.sql']), log: () => {} }).check(A)).toEqual({ ok: true })
    expect(await schemaGate({ dirs, openDb: async () => fakeDb(['0001_core.sql', '0003_core.sql']), log: () => {} }).check(A)).toMatchObject({ ok: false, reason: 'behind' })
  })

  it('refuses a migration number found in two dirs (DUPLICATE_MIGRATION) at construction', () => {
    expect(() => schemaGate({ dirs: [core, dup], openDb: async () => fakeDb([]) })).toThrow(/DUPLICATE_MIGRATION 0003_other\.sql/)
  })

  it('needs exactly one of dir or dirs', () => {
    expect(() => schemaGate({ dir, dirs: [core], openDb: async () => fakeDb([]) })).toThrow(/exactly one/)
    expect(() => schemaGate({ openDb: async () => fakeDb([]) } as never)).toThrow(/exactly one/)
  })

  it('cacheTtlMs 0 judges every request afresh (Q9: a newly migrated tenant is served on the very next request)', async () => {
    let files = ['001_a.sql']
    const gate = schemaGate({ dir, cacheTtlMs: 0, openDb: async () => fakeDb(files), log: () => {} })
    expect(await gate.check(A)).toMatchObject({ ok: false, reason: 'behind' })
    files = ['001_a.sql', '002_b.sql']
    expect(await gate.check(A)).toEqual({ ok: true })
  })
})
