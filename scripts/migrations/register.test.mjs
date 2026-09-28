// TASK-029 TDD 1-5, 9: the migration register's loader, coverage, pad/order,
// claim, lock and StuRa-tree checks. Fixture states are built in memory (a
// register, a file list with bytes, a lock, an eol lookup), so every RED case
// is exactly one change away from a GREEN base; the real-tree cases read the
// kernel checkout through git. Every test() is top-level: `make
// lint-migration-register` compares their count with node's TAP plan.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { check, claim, freeze, globToRegExp, loadRegister, RegisterError, treeState } from './register.mjs'

const codes = (problems) => [...new Set(problems.map((p) => p.code))].sort()

function base() {
  const register = {
    chains: [
      {
        id: 'k',
        database: 'kernel',
        dirs: ['k/m', 'mod/c/app/m'],
        padWidth: 4,
        highWater: 4,
        legacyFloor: 3,
        legacy: ['0001_a.sql', '0003_c.sql'],
        blocks: [{ dir: 'mod/c/app/m', lo: 1200, hi: 1299, highWater: 1200 }],
      },
      { id: 'leaf', database: 'module:x', dirs: ['mod/x/m'], padWidth: 3, highWater: 2, legacyFloor: 0, legacy: [] },
      { id: 'svc', database: 'service:s', dirs: ['svc/s/m/a', 'svc/s/m/b'], padWidth: 4, highWater: 0, legacyFloor: 0, legacy: [] },
    ],
    nonMigration: [{ glob: 'fx/**', reason: 'fixture' }],
  }
  const paths = ['k/m/0001_a.sql', 'k/m/0003_c.sql', 'k/m/0004_d.sql', 'mod/c/app/m/1200_x.sql', 'mod/x/m/001_init.sql', 'mod/x/m/002_more.sql', 'fx/0001_a.sql']
  const files = paths.map((path) => ({ path, bytes: Buffer.from(`-- ${path}\nSELECT 1;\n`) }))
  const lock = freeze({ register, lock: undefined, files, chains: ['k', 'leaf', 'svc'], frozenAt: '2026-09-28' })
  return { register, lock, slugs: { count: 2, slugs: ['stura_only', 'money_fk_indexes'] }, files, eolOf: () => 'lf' }
}

const withFile = (s, path, body = `-- ${path}\n`) => ({ ...s, files: [...s.files, { path, bytes: Buffer.from(body) }] })
const without = (s, path) => ({ ...s, files: s.files.filter((f) => f.path !== path) })
const hw = (s, id, n) => {
  const register = structuredClone(s.register)
  register.chains.find((c) => c.id === id).highWater = n
  return { ...s, register }
}

test('base fixture state is GREEN (every RED below is one change away from it)', () => {
  assert.deepEqual(check(base()), [])
})

// ---- TDD 1: loader ------------------------------------------------------
test('loader: malformed register is REGISTER_MALFORMED', () => {
  assert.throws(() => loadRegister('{not json'), (e) => e instanceof RegisterError && e.code === 'REGISTER_MALFORMED')
  assert.throws(() => loadRegister({ chains: [] , nonMigration: [] }), (e) => e.code === 'REGISTER_MALFORMED')
  assert.deepEqual(codes(check({ ...base(), register: { chains: 'x' } })), ['REGISTER_MALFORMED'])
})

test('loader: a dir declared by two chains is DIR_IN_TWO_CHAINS', () => {
  const s = base()
  s.register.chains[1].dirs.push('k/m')
  assert.throws(() => loadRegister(s.register), (e) => e.code === 'DIR_IN_TWO_CHAINS')
})

test('loader: highWater below the highest file is HIGH_WATER_BEHIND (a missing claim bump)', () => {
  const s = withFile(base(), 'k/m/0005_e.sql')
  assert.deepEqual(codes(check(s)), ['HIGH_WATER_BEHIND'])
})

test('loader: a chain without padWidth is NO_PAD_WIDTH', () => {
  const s = base()
  delete s.register.chains[2].padWidth
  assert.throws(() => loadRegister(s.register), (e) => e.code === 'NO_PAD_WIDTH')
})

// ---- TDD 2: coverage ----------------------------------------------------
test('coverage: a seeded services/x/migrations/0001_a.sql is UNREGISTERED', () => {
  assert.deepEqual(codes(check(withFile(base(), 'services/x/migrations/0001_a.sql'))), ['UNREGISTERED'])
})

test('coverage: zero *.sql files is NO_FILES, never a vacuous pass', () => {
  const s = { ...base(), files: [] }
  assert.ok(codes(check(s)).includes('NO_FILES'))
})

test('coverage: a fixture passes only via its nonMigration row (row removed RED, stale row RED)', () => {
  const s = withFile(base(), 'scripts/verify/__fixtures__/x/0001_a.sql')
  assert.deepEqual(codes(check(s)), ['UNREGISTERED'])
  const withRow = structuredClone(s.register)
  withRow.nonMigration.push({ glob: 'scripts/verify/__fixtures__/**', reason: 'verify fixtures' })
  assert.deepEqual(check({ ...s, register: withRow }), [])
  // the row stays, the file goes: the row is stale
  assert.deepEqual(codes(check({ ...base(), register: withRow })), ['STALE_NON_MIGRATION'])
})

test('coverage: a file in a chain dir that also matches a nonMigration row is AMBIGUOUS_FILE', () => {
  const s = base()
  s.register.nonMigration.push({ glob: 'mod/x/**', reason: 'wrong' })
  assert.ok(codes(check(s)).includes('AMBIGUOUS_FILE'))
})

test('coverage: globToRegExp handles **, * and literal dots', () => {
  assert.ok(globToRegExp('packages/tenant-store/**/fixtures/**').test('packages/tenant-store/test/fixtures/migrations/fixture/001_init.sql'))
  assert.ok(globToRegExp('a/*.fixture.sql').test('a/x.fixture.sql'))
  assert.ok(!globToRegExp('a/*.fixture.sql').test('a/b/x.fixture.sql'))
  assert.ok(!globToRegExp('a/x.sql').test('a/xxsql'))
})

// ---- TDD 3: pad and order -----------------------------------------------
test('pad: a three-digit file under pad 4 is WRONG_PAD', () => {
  const s = hw(withFile(base(), 'k/m/005_e.sql'), 'k', 5)
  const lock = freeze({ register: s.register, lock: s.lock, files: s.files, chains: ['k'], frozenAt: 'x' })
  assert.deepEqual(codes(check({ ...s, lock })), ['WRONG_PAD'])
})

test('order: 130_x.sql beside 1200_ sorts after it -- ORDER (and WRONG_PAD)', () => {
  const s = base()
  s.register.chains.push({ id: 'o', database: 'module:o', dirs: ['o/m'], padWidth: 3, highWater: 1200, legacyFloor: 0, legacy: [] })
  const got = codes(check(withFile(withFile(s, 'o/m/130_x.sql'), 'o/m/1200_y.sql')))
  assert.ok(got.includes('ORDER'), got.join(','))
  assert.ok(got.includes('WRONG_PAD'), got.join(','))
})

test('block: a file outside its block range is OUT_OF_BLOCK', () => {
  const s = withFile(base(), 'mod/c/app/m/1300_z.sql')
  s.register.chains[0].blocks[0].highWater = 1300
  const got = codes(check(s))
  assert.ok(got.includes('OUT_OF_BLOCK'), got.join(','))
})

// ---- TDD 4: claim --------------------------------------------------------
test('claim: a gap above the legacy floor is GAP', () => {
  const s = hw(withFile(base(), 'k/m/0006_f.sql'), 'k', 6)
  const lock = freeze({ register: s.register, lock: s.lock, files: s.files, chains: ['k'], frozenAt: 'x' })
  assert.deepEqual(codes(check({ ...s, lock })), ['GAP'])
})

test('claim: a duplicate number is DUPLICATE_NUMBER', () => {
  const s = withFile(base(), 'k/m/0004_dd.sql')
  const lock = freeze({ register: s.register, lock: s.lock, files: s.files, chains: ['k'], frozenAt: 'x' })
  assert.deepEqual(codes(check({ ...s, lock })), ['DUPLICATE_NUMBER'])
})

test('claim: a file below the floor that is not in legacy[] is NOT_LEGACY', () => {
  const s = withFile(base(), 'k/m/0002_b.sql')
  const lock = freeze({ register: s.register, lock: s.lock, files: s.files, chains: ['k'], frozenAt: 'x' })
  assert.deepEqual(codes(check({ ...s, lock })), ['NOT_LEGACY'])
})

test('claim: claim + add + freeze + check is GREEN, and bumps exactly one highWater line', () => {
  const s = base()
  const r = claim({ register: s.register, files: s.files.map((f) => f.path), chain: 'k', name: 'next_thing' })
  assert.equal(r.filename, '0005_next_thing.sql')
  assert.equal(r.dir, 'k/m')
  assert.equal(r.register.chains[0].highWater, 5)
  assert.equal(s.register.chains[0].highWater, 4, 'claim does not mutate its input')
  const t = withFile({ ...s, register: r.register }, `${r.dir}/${r.filename}`)
  assert.deepEqual(codes(check(t)), ['NOT_LOCKED'])
  const lock = freeze({ register: t.register, lock: t.lock, files: t.files, chains: ['k'], frozenAt: 'x' })
  assert.deepEqual(check({ ...t, lock }), [])
  // a block claim and an empty service chain start where their sequence starts
  assert.equal(claim({ register: s.register, files: s.files.map((f) => f.path), chain: 'k', name: 'c', dir: 'mod/c/app/m' }).filename, '1201_c.sql')
  assert.equal(claim({ register: s.register, files: s.files.map((f) => f.path), chain: 'svc', name: 'first' }).filename, '0001_first.sql')
  assert.throws(() => claim({ register: s.register, files: [], chain: 'k', name: 'Bad-Name' }), (e) => e.code === 'BAD_NAME')
})

test('claim: a new 0013_x.sql is RED on the REAL register', () => {
  const s = withFile(treeState(), 'gremion-ui/migrations/0013_x.sql')
  const got = codes(check(s))
  assert.ok(got.includes('NOT_LEGACY'), got.join(','))
  assert.ok(got.includes('NOT_LOCKED'), got.join(','))
})

// ---- TDD 5: the lock ----------------------------------------------------
test('lock: renaming a locked file is RED (LOCKED_FILE_MISSING + NOT_LOCKED)', () => {
  const s = base()
  const f = s.files.find((x) => x.path === 'mod/x/m/002_more.sql')
  const t = { ...s, files: s.files.map((x) => (x === f ? { ...x, path: 'mod/x/m/002_renamed.sql' } : x)) }
  assert.deepEqual(codes(check(t)), ['LOCKED_FILE_MISSING', 'NOT_LOCKED'])
})

test('lock: renumbering a locked file is RED', () => {
  const s = base()
  const t = { ...s, files: s.files.map((x) => (x.path === 'k/m/0004_d.sql' ? { ...x, path: 'k/m/0005_d.sql' } : x)) }
  const got = codes(check(hw(t, 'k', 5)))
  assert.ok(got.includes('LOCKED_FILE_MISSING') && got.includes('NOT_LOCKED'), got.join(','))
})

test('lock: one changed byte in a locked file is LOCKED_FILE_CHANGED', () => {
  const s = base()
  const t = { ...s, files: s.files.map((x) => (x.path === 'k/m/0003_c.sql' ? { ...x, bytes: Buffer.from(`${x.bytes.toString()} `) } : x)) }
  assert.deepEqual(codes(check(t)), ['LOCKED_FILE_CHANGED'])
})

test('lock: deleting a locked file is RED', () => {
  assert.ok(codes(check(without(base(), 'k/m/0003_c.sql'))).includes('LOCKED_FILE_MISSING'))
})

test('lock: a chain file absent from the lock is NOT_LOCKED', () => {
  const s = base()
  delete s.lock.chains.leaf.files['002_more.sql']
  assert.deepEqual(codes(check(s)), ['NOT_LOCKED'])
})

test('lock: an absent lock is LOCK_MISSING, never read as {}', () => {
  assert.deepEqual(codes(check({ ...base(), lock: undefined })), ['LOCK_MISSING'])
})

test('lock: a malformed lock is LOCK_MALFORMED', () => {
  assert.deepEqual(codes(check({ ...base(), lock: null })), ['LOCK_MALFORMED'])
  assert.deepEqual(codes(check({ ...base(), lock: { frozenAt: 'x', chains: { k: { files: { 'a.sql': 'nothex' } } } } })), ['LOCK_MALFORMED'])
})

test('lock: a chain file without eol=lf is EOL_ATTR', () => {
  const s = base()
  assert.deepEqual(codes(check({ ...s, eolOf: (p) => (p === 'k/m/0004_d.sql' ? '' : 'lf') })), ['EOL_ATTR'])
})

test('lock: editing legacyFloor or legacy[] after the freeze is LEGACY_EDITED', () => {
  const s = base()
  s.register.chains[0].legacy = ['0001_a.sql']
  assert.ok(codes(check(s)).includes('LEGACY_EDITED'))
})

test('lock: freeze never re-hashes a changed locked file and never unlocks a missing one', () => {
  const s = base()
  const changed = s.files.map((x) => (x.path === 'k/m/0001_a.sql' ? { ...x, bytes: Buffer.from('changed') } : x))
  assert.throws(() => freeze({ register: s.register, lock: s.lock, files: changed, chains: ['k'], frozenAt: 'x' }), (e) => e.code === 'LOCKED_FILE_CHANGED')
  assert.throws(() => freeze({ register: s.register, lock: s.lock, files: without(s, 'k/m/0001_a.sql').files, chains: ['k'], frozenAt: 'x' }), (e) => e.code === 'LOCKED_FILE_MISSING')
})

test('empty chain: a declared dir may be absent only while highWater is 0 and nothing is locked', () => {
  assert.deepEqual(codes(check(hw(base(), 'svc', 1))), ['HIGH_WATER_MISMATCH'])
  const s = base()
  s.lock.chains.svc.files['0001_ghost.sql'] = 'a'.repeat(64)
  assert.deepEqual(codes(check(s)), ['LOCKED_FILE_MISSING'])
})

// ---- TDD 9: the StuRa tree ------------------------------------------------
test('stura: 0059_money_running_no_fiscal_year_idx.sql in gremion-ui/migrations is STURA_SLUG on the REAL register', () => {
  // claimed properly (highWater bumped), so only the StuRa rule can refuse it
  const got = codes(check(hw(withFile(treeState(), 'gremion-ui/migrations/0059_money_running_no_fiscal_year_idx.sql'), 'kernel-data', 59)))
  assert.ok(got.includes('STURA_SLUG'), got.join(','))
})

test('stura: a listed slug fails at any number in a kernel-database chain, not in a module leaf database', () => {
  const s = hw(withFile(base(), 'k/m/0005_money_fk_indexes.sql'), 'k', 5)
  const lock = freeze({ register: s.register, lock: s.lock, files: s.files, chains: ['k'], frozenAt: 'x' })
  assert.deepEqual(codes(check({ ...s, lock })), ['STURA_SLUG'])
  const t = hw(withFile(base(), 'mod/x/m/003_money_fk_indexes.sql'), 'leaf', 3)
  const lock2 = freeze({ register: t.register, lock: t.lock, files: t.files, chains: ['leaf'], frozenAt: 'x' })
  assert.deepEqual(check({ ...t, lock: lock2 }), [])
})

test('stura: modules/x/migrations/1005_f.sql is STURA_RANGE (and UNREGISTERED)', () => {
  assert.deepEqual(codes(check(withFile(base(), 'modules/x/migrations/1005_f.sql'))), ['STURA_RANGE', 'UNREGISTERED'])
})

test('stura: an emptied slug list is STURA_LIST_INVALID, and a listed slug then no longer fails', () => {
  assert.deepEqual(codes(check({ ...base(), slugs: { slugs: [] } })), ['STURA_LIST_INVALID'])
  assert.deepEqual(codes(check({ ...base(), slugs: { count: 29, slugs: ['a'] } })), ['STURA_LIST_INVALID'])
})

// ---- the real tree ---------------------------------------------------------
test('real tree: the kernel checkout passes the register check', () => {
  const s = treeState()
  assert.ok(s.files.length > 0, 'git listed zero *.sql files')
  assert.deepEqual(check(s), [])
})

test('real tree: kernel-data holds the 31 legacy files (floor 58) plus the content app block', () => {
  const s = treeState()
  const k = s.register.chains.find((c) => c.id === 'kernel-data')
  assert.equal(k.legacy.length, 31)
  assert.equal(k.legacyFloor, 58)
  const files = s.files.filter((f) => k.dirs.some((d) => f.path.startsWith(`${d}/`)))
  assert.equal(files.length, 33)
  assert.equal(s.slugs.slugs.length, 29)
})
