// TASK-029 TDD 6 (runtime refusal) and TDD 7/8 (boot verification, TRD-040),
// database-free. The runner here follows TASK-020's contract exactly as far as
// the hook sees it: preApply(file, ctx) under the lock BEFORE each pending
// file's transaction, the same ctx object for every call of one run, a throw
// aborting the run with that file and every later one unapplied. The ledger
// and a DDL log are plain arrays, so "unchanged" is a deep-equal.
// The same hook and verifier run against Postgres 18 in
// packages/tenant-store/test/integration/verify-applied.test.ts.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chainFileNames, chainPreApply, ChainRefusal } from './pre-apply.mjs'
import { compareLedger, readChain, verifyApplied, VerifyAppliedError } from './verify-applied.mjs'
import { byName, REPO_ROOT } from './register.mjs'

async function run({ ledger, pending, hook }) {
  const state = { ledger: [...ledger], ddl: [] }
  const ctx = { applied: [...ledger].sort(byName), pending: [...pending].sort(byName) }
  for (const f of ctx.pending) {
    await hook(f, ctx)
    state.ddl.push(`DDL ${f}`)
    state.ledger.push(f)
  }
  return state
}

async function refused(o, code) {
  const before = { ledger: [...o.ledger], ddl: [] }
  let err
  const state = { ledger: [...o.ledger], ddl: [] }
  try {
    const ctx = { applied: [...o.ledger].sort(byName), pending: [...o.pending].sort(byName) }
    for (const f of ctx.pending) {
      await o.hook(f, ctx)
      state.ddl.push(`DDL ${f}`)
      state.ledger.push(f)
    }
  } catch (e) {
    err = e
  }
  assert.ok(err instanceof ChainRefusal, `expected a refusal, the run applied ${state.ddl.join(', ') || 'nothing'}`)
  assert.equal(err.code, code)
  assert.deepEqual(state, before, 'ledger and DDL log unchanged')
  return err
}

test('6a: ledger 0003_a, chain 0004_a -> refused (the applied name is gone), nothing applied', async () => {
  const hook = chainPreApply({ chainFiles: ['0001_x.sql', '0002_y.sql', '0004_a.sql', '0005_z.sql'] })
  const err = await refused({ ledger: ['0001_x.sql', '0002_y.sql', '0003_a.sql'], pending: ['0004_a.sql', '0005_z.sql'], hook }, 'LEDGER_NAME_NOT_IN_CHAIN')
  assert.deepEqual(err.files, ['0003_a.sql'])
})

test('6b: ledger {0001,0002,0005}, 0003_x pending and not catch-up -> refused', async () => {
  const hook = chainPreApply({ chainFiles: ['0001_a.sql', '0002_b.sql', '0003_x.sql', '0005_c.sql'] })
  const err = await refused({ ledger: ['0001_a.sql', '0002_b.sql', '0005_c.sql'], pending: ['0003_x.sql'], hook }, 'BELOW_HIGH_WATER')
  assert.deepEqual(err.files, ['0003_x.sql'])
})

test('6c: two pending, the SECOND offends -> nothing applied (whole chain checked on the first call)', async () => {
  // 0002 is a declared catch-up (fine on its own); 0003 is not. A per-file
  // check would apply 0002 and then refuse 0003.
  const hook = chainPreApply({ chainFiles: ['0001_a.sql', '0002_c.sql', '0003_x.sql', '0004_b.sql'], catchUp: ['0002_c.sql'] })
  await refused({ ledger: ['0001_a.sql', '0004_b.sql'], pending: ['0002_c.sql', '0003_x.sql'], hook }, 'BELOW_HIGH_WATER')
})

test('6d: below-high-water catch-up WITH expected -> applied and logged; WITHOUT -> refused', async () => {
  const logs = []
  const chainFiles = ['0001_a.sql', '0002_c.sql', '0004_b.sql', '0005_n.sql']
  const ok = await run({ ledger: ['0001_a.sql', '0004_b.sql'], chainFiles, pending: ['0002_c.sql', '0005_n.sql'], hook: chainPreApply({ chainFiles, catchUp: ['0002_c.sql'], log: (l) => logs.push(l) }) })
  assert.deepEqual(ok.ddl, ['DDL 0002_c.sql', 'DDL 0005_n.sql'])
  assert.match(logs.join('\n'), /declared catch-up below high-water 4: 0002_c\.sql/)
  await refused({ ledger: ['0001_a.sql', '0004_b.sql'], pending: ['0002_c.sql', '0005_n.sql'], hook: chainPreApply({ chainFiles }) }, 'BELOW_HIGH_WATER')
})

test('6: the check runs once per run (same ctx), and again for a new run', async () => {
  let calls = 0
  const chainFiles = ['0001_a.sql', '0002_b.sql', '0003_c.sql']
  const hook = chainPreApply({ chainFiles, log: () => calls++ })
  const s = await run({ ledger: ['0001_a.sql'], chainFiles, pending: ['0002_b.sql', '0003_c.sql'], hook })
  assert.equal(s.ddl.length, 2)
  assert.equal(calls, 0, 'nothing below the high-water, nothing logged')
  // a NEW run (new ctx) is checked again
  assert.throws(() => hook('x', { applied: ['0009_gone.sql'], pending: ['x'] }), (e) => e.code === 'LEDGER_NAME_NOT_IN_CHAIN')
  assert.throws(() => chainPreApply({ chainFiles: [] }), (e) => e.code === 'EMPTY_CHAIN')
})

test('6: the kernel-data chain is the union of its dirs ordered by number (0058 before 1200)', () => {
  const names = chainFileNames('kernel-data', { root: REPO_ROOT })
  // 31 legacy + F1-FIX-02-K's claimed 0059 + TRD-196's claimed 0060 + the content app block (1200, 1201)
  assert.equal(names.length, 35)
  assert.equal(names.at(-5), '0058_public_reader_grants.sql')
  assert.equal(names.at(-4), '0059_audit_log_chain_anchor.sql')
  assert.equal(names.at(-3), '0060_erasure_report.sql')
  assert.deepEqual(names.slice(-2), ['1200_content_news_posts.sql', '1201_news_posts_public_reader_columns.sql'])
})

test('6: a pre-renumber (pad-3) kernel ledger is refused against the real kernel-data chain before any DDL, naming every pad-3 row', async () => {
  // The hook the gremion-ui move onto tenant-store must wire (residual,
  // TASK-038 re-asserts): today db.ts compares ledger names only through
  // applied.has(file) and would start re-applying at 0001_ on such a database.
  const chainFiles = chainFileNames('kernel-data', { root: REPO_ROOT })
  // A pre-renumber ledger can only hold the files that existed before the
  // renumber (<= 0058); 0059 (F1-FIX-02-K) was claimed after it, pad 4 only.
  const pad3 = chainFiles.filter((f) => /^0\d{3}_/.test(f) && f < '0059').map((f) => f.slice(1))
  assert.equal(pad3.length, 31)
  const err = await refused({ ledger: pad3, pending: chainFiles, hook: chainPreApply({ chainFiles }) }, 'LEDGER_NAME_NOT_IN_CHAIN')
  assert.deepEqual([...err.files].sort(byName), [...pad3].sort(byName))
  assert.equal(chainFiles[0], '0001_governance_schema.sql')
  assert.ok(err.files.includes(chainFiles[0].slice(1)), 'the first kernel migration, in its pad-3 spelling, is named')
})

// ---- TDD 7/8 against an in-memory ledger ------------------------------------
const sha = (s) => createHash('sha256').update(s).digest('hex')

function chainDir(files, { manifest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 't029-chain-'))
  const m = {}
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body)
    m[name] = sha(body)
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, ...manifest }))
  return dir
}

/** A fake postgres-js tagged template answering the verifier's three queries. */
function fakeSql({ table = true, hashColumn = true, rows = [] }) {
  return async (strings) => {
    const q = strings.join('?')
    if (q.includes('to_regclass(') && q.includes('AS present') && !q.includes('pg_attribute')) return [{ present: table }]
    if (q.includes('pg_attribute')) return [{ present: hashColumn }]
    if (q.includes('SELECT filename, sha256')) return rows
    if (q.includes('SELECT filename FROM')) return rows.map((r) => ({ filename: r.filename }))
    throw new Error(`unexpected query ${q}`)
  }
}

test('7: verifyApplied passes when row hash = manifest = file, and counts the rows', async () => {
  const dir = chainDir({ '0001_a.sql': 'select 1;\n', '0002_b.sql': 'select 2;\n' })
  try {
    const rows = [{ filename: '0001_a.sql', sha256: sha('select 1;\n') }]
    assert.deepEqual(await verifyApplied({ sql: fakeSql({ rows }), dirs: [dir] }), { rows: 1, verified: ['0001_a.sql'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('7: an applied file edited and its manifest regenerated (RED B shape) -> refused, naming the file', async () => {
  const dir = chainDir({ '0001_a.sql': 'select 1; -- edited after apply\n' })
  try {
    const rows = [{ filename: '0001_a.sql', sha256: sha('select 1;\n') }]
    await assert.rejects(verifyApplied({ sql: fakeSql({ rows }), dirs: [dir] }), (e) => e instanceof VerifyAppliedError && /APPLIED_NOT_MANIFEST 0001_a\.sql/.test(e.message))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('7: a tampered manifest entry for an applied file (RED A shape) -> refused, naming the file', async () => {
  const dir = chainDir({ '0001_a.sql': 'select 1;\n' }, { manifest: { '0001_a.sql': sha('other') } })
  try {
    const rows = [{ filename: '0001_a.sql', sha256: sha('select 1;\n') }]
    await assert.rejects(verifyApplied({ sql: fakeSql({ rows }), dirs: [dir] }), /FILE_NOT_MANIFEST 0001_a\.sql/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('7: a NULL or empty sha256 row, or a ledger with no sha256 column, is refused naming the row -- never skipped', async () => {
  const dir = chainDir({ '0001_a.sql': 'select 1;\n' })
  try {
    await assert.rejects(verifyApplied({ sql: fakeSql({ rows: [{ filename: '0001_a.sql', sha256: null }] }), dirs: [dir] }), /NULL_HASH 0001_a\.sql/)
    await assert.rejects(verifyApplied({ sql: fakeSql({ rows: [{ filename: '0001_a.sql', sha256: '' }] }), dirs: [dir] }), /NULL_HASH 0001_a\.sql/)
    await assert.rejects(verifyApplied({ sql: fakeSql({ hashColumn: false, rows: [{ filename: '0001_a.sql' }] }), dirs: [dir] }), /LEDGER_WITHOUT_HASH 0001_a\.sql/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('7: no ledger table yet (nothing applied) boots; an empty chain is refused', async () => {
  const dir = chainDir({ '0001_a.sql': 'select 1;\n' })
  try {
    assert.deepEqual(await verifyApplied({ sql: fakeSql({ table: false }), dirs: [dir] }), { rows: 0, verified: [] })
    await assert.rejects(verifyApplied({ sql: fakeSql({}), dirs: [join(dir, 'nope')] }), /NO_MIGRATIONS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('8 (TRD-040): rows = files minus declared skips; undeclared missing row RED; extra row RED', () => {
  const dir = chainDir({ '0001_a.sql': 'a', '0002_dev_seed.sql': 'b', '0003_c.sql': 'c' })
  try {
    const { files: chain } = readChain([dir])
    const row = (f, b) => ({ filename: f, sha256: sha(b) })
    const ok = [row('0001_a.sql', 'a'), row('0003_c.sql', 'c')]
    assert.deepEqual(compareLedger({ rows: ok, hasHash: true, chain, skips: ['0002_dev_seed.sql'], requireComplete: true }), [])
    assert.deepEqual(compareLedger({ rows: ok, hasHash: true, chain, requireComplete: true }).map((p) => `${p.code} ${p.file}`), ['UNDECLARED_MISSING_ROW 0002_dev_seed.sql'])
    assert.deepEqual(
      compareLedger({ rows: [...ok, row('0004_x.sql', 'x')], hasHash: true, chain, skips: ['0002_dev_seed.sql'], requireComplete: true }).map((p) => `${p.code} ${p.file}`),
      ['EXTRA_ROW 0004_x.sql'],
    )
    assert.deepEqual(
      compareLedger({ rows: [...ok, row('0002_dev_seed.sql', 'b')], hasHash: true, chain, skips: ['0002_dev_seed.sql'], requireComplete: true }).map((p) => p.code),
      ['EXTRA_ROW'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
