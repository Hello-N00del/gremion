// TASK-075 TDD 1 (every refused and allowed form of the expand/migrate lint)
// and TDD 2 (the contract rule against a real git repository).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { checkContract, lintSql, RULES } from './lint.mjs'

const LT = "SET LOCAL lock_timeout = '5s';\n"
const expand = (body) => `-- gremion:phase expand\n${LT}${body}`
const migrate = (body) => `-- gremion:phase migrate\n${LT}${body}`
const rules = (text, opts) => lintSql(text, opts).problems.map((p) => p.rule)

describe('expand: refused forms name the statement and the rule', () => {
  const refused = [
    ['DROP TABLE old_things;', RULES.drop, 2],
    ['ALTER TABLE t DROP COLUMN c;', RULES.drop, 2],
    ['ALTER TABLE t RENAME COLUMN a TO b;', RULES.rename, 2],
    ['ALTER TABLE t RENAME TO t2;', RULES.rename, 2],
    ['ALTER TABLE t ALTER COLUMN c TYPE bigint;', RULES.alterColumnType, 2],
    ['ALTER TABLE t ALTER c SET DATA TYPE bigint;', RULES.alterColumnType, 2],
    ['ALTER TABLE t ALTER COLUMN c SET NOT NULL;', RULES.setNotNull, 2],
    ['ALTER TABLE t ALTER COLUMN c SET DEFAULT 1;', RULES.alterColumn, 2],
    ['ALTER TABLE t ADD COLUMN c integer NOT NULL;', RULES.notNullNoDefault, 2],
    ['ALTER TABLE t ADD COLUMN id uuid DEFAULT uuidv7();', RULES.uuidv7Default, 2],
    ['ALTER TABLE t ADD COLUMN at timestamptz DEFAULT clock_timestamp();', RULES.volatileDefault, 2],
    ['ALTER TABLE t ADD COLUMN r uuid REFERENCES other (id);', RULES.foreignKey, 2],
    ['ALTER TABLE t ADD COLUMN u text UNIQUE;', RULES.columnConstraint, 2],
    ['ALTER TABLE t ADD COLUMN n int CHECK (n > 0);', RULES.columnConstraint, 2],
    ['ALTER TABLE t ADD CONSTRAINT t_r_fk FOREIGN KEY (r) REFERENCES other (id) NOT VALID;', RULES.foreignKey, 2],
    ['ALTER TABLE t ADD CONSTRAINT t_n_ck CHECK (n > 0);', RULES.checkNotValid, 2],
    ['ALTER TABLE t ADD CONSTRAINT t_u UNIQUE (u);', RULES.constraintExisting, 2],
    ['ALTER TABLE t ENABLE ROW LEVEL SECURITY;', RULES.rlsExisting, 2],
    ['ALTER TABLE t FORCE ROW LEVEL SECURITY;', RULES.rlsExisting, 2],
    ['CREATE POLICY p ON t USING (true);', RULES.policyExisting, 2],
    ['CREATE INDEX t_c_idx ON t (c);', RULES.indexExisting, 2],
    ['CREATE UNIQUE INDEX IF NOT EXISTS t_c_uq ON public.t (c);', RULES.indexExisting, 2],
    ['CREATE INDEX CONCURRENTLY t_c_idx ON t (c);', RULES.concurrently, 2],
    ['CREATE TRIGGER t_trg BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();', RULES.triggerExisting, 2],
    ['INSERT INTO t (a) VALUES (1);', RULES.insertExisting, 2],
    ['UPDATE t SET a = 1;', RULES.update, 2],
    ['DELETE FROM t;', RULES.delete, 2],
    ['TRUNCATE t;', RULES.truncate, 2],
    ['REVOKE SELECT ON t FROM PUBLIC;', RULES.revoke, 2],
    ['CREATE EXTENSION pgcrypto;', RULES.createExtension, 2],
    ['CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', RULES.orReplace, 2],
    ['CREATE OR REPLACE VIEW v AS SELECT 1;', RULES.orReplace, 2],
    ['DO $$ BEGIN PERFORM 1; END $$;', RULES.doBlock, 2],
    ['CREATE TABLE t2 AS SELECT * FROM t;', RULES.createTableAs, 2],
    ['CREATE TABLE t_2026 PARTITION OF t FOR VALUES FROM (1) TO (2);', RULES.inheritsExisting, 2],
    ['CREATE TYPE mood AS ENUM (\'a\');', RULES.notAllowed, 2],
    ['VACUUM t;', RULES.notAllowed, 2],
    ['SET search_path = pg_catalog;', RULES.notAllowed, 2],
    ['SELECT 1;', RULES.notAllowed, 2],
  ]
  for (const [sql, rule, statement] of refused) {
    test(`${sql} -> ${rule}`, () => {
      const r = lintSql(expand(`${sql}\n`))
      assert.equal(r.phase, 'expand')
      assert.deepEqual(r.problems.map((p) => [p.statement, p.rule]), [[statement, rule]], JSON.stringify(r.problems))
    })
  }

  test('a function or view of a name an earlier file created is not new', () => {
    const prior = new Set(['f'])
    assert.deepEqual(rules(expand('CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n'), { priorRoutines: prior }), [RULES.notNewName])
    assert.deepEqual(rules(expand('CREATE VIEW f AS SELECT 1;\n'), { priorRoutines: prior }), [RULES.notNewName])
  })

  test('no header, a header not on line 1, a malformed marker', () => {
    assert.deepEqual(rules(`${LT}CREATE TABLE a (id int);\n`), [RULES.headerMissing])
    assert.deepEqual(rules(`\n-- gremion:phase expand\n${LT}`), [RULES.headerMalformed])
    assert.deepEqual(rules(`-- gremion:phase expnd\n${LT}`), [RULES.headerMalformed])
    assert.deepEqual(rules(`-- gremion:phase expand\n-- gremion:contract-after dist-v1.0.0\n${LT}`), [RULES.headerMalformed])
  })

  test('no lock_timeout, or lock_timeout only after the first locking statement', () => {
    assert.deepEqual(rules('-- gremion:phase expand\nCREATE TABLE a (id int);\n'), [RULES.noLockTimeout])
    const late = lintSql(`-- gremion:phase expand\nCREATE TABLE a (id int);\n${LT}CREATE TABLE b (id int);\n`)
    assert.deepEqual(late.problems.map((p) => [p.statement, p.rule]), [[1, RULES.noLockTimeout]])
    assert.deepEqual(rules('-- gremion:phase expand\nCOMMENT ON SCHEMA public IS \'x\';\n'), [RULES.noLockTimeout])
  })

  test('unparseable text fails by name, never passes', () => {
    assert.deepEqual(rules(expand("CREATE TABLE a (id text DEFAULT 'x);\n")), [RULES.unparseable])
    assert.deepEqual(rules(expand('CREATE TABLE a (id int)\n/* never closed\n')), [RULES.unparseable])
  })

  test('transaction control other than the outer wrapper is refused', () => {
    assert.deepEqual(rules(expand('CREATE TABLE a (id int);\nCOMMIT;\nCREATE TABLE b (id int);\n')), [RULES.txControl])
    assert.deepEqual(rules(expand('SAVEPOINT s;\n')), [RULES.txControl])
  })

  test('every problem of a file is reported, each with its own statement number', () => {
    const r = lintSql(expand('CREATE TABLE ok (id int);\nDROP TABLE a;\nUPDATE b SET c = 1;\n'))
    assert.deepEqual(r.problems.map((p) => [p.statement, p.rule]), [[3, RULES.drop], [4, RULES.update]])
  })
})

describe('expand: allowed forms pass', () => {
  test('a new table with its index, trigger, RLS, policy and seed rows; new function and view; comments and grants', () => {
    const text = `-- gremion:phase expand
-- a comment line in the header block is fine
BEGIN;
SET LOCAL lock_timeout = '3s';
CREATE SCHEMA IF NOT EXISTS gov;
CREATE TABLE IF NOT EXISTS gov.thing (
  id   uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('a', 'b')),
  body_id uuid REFERENCES gov.body (id)
);
CREATE INDEX thing_kind_idx ON gov.thing (kind);
CREATE UNIQUE INDEX IF NOT EXISTS thing_body_uq ON thing (body_id);
CREATE TRIGGER thing_touch BEFORE UPDATE ON gov.thing FOR EACH ROW EXECUTE FUNCTION gov.touch();
ALTER TABLE gov.thing ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY thing FORCE ROW LEVEL SECURITY;
CREATE POLICY thing_tenant ON gov.thing USING (true);
INSERT INTO gov.thing (kind) VALUES ('a') ON CONFLICT DO NOTHING;
CREATE FUNCTION gov.thing_count() RETURNS bigint LANGUAGE sql STABLE AS $f$ SELECT count(*) FROM gov.thing; $f$;
CREATE VIEW gov.thing_v AS SELECT id, kind FROM gov.thing;
COMMENT ON TABLE gov.thing IS 'DROP TABLE is only text here';
GRANT SELECT ON gov.thing TO app;
COMMIT;
`
    assert.deepEqual(lintSql(text).problems, [])
  })

  test('additive columns on an existing table: nullable, literal default, now(), cast literal; NOT VALID check; VALIDATE', () => {
    const text = expand(`ALTER TABLE t ADD COLUMN a text;
ALTER TABLE t ADD COLUMN IF NOT EXISTS b integer DEFAULT 0, ADD COLUMN c boolean NOT NULL DEFAULT false;
ALTER TABLE t ADD d timestamptz NOT NULL DEFAULT now();
ALTER TABLE t ADD COLUMN e timestamptz DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE t ADD COLUMN f jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE t ADD COLUMN g numeric(10,2) DEFAULT -1.5;
ALTER TABLE t ADD COLUMN h text COLLATE "C";
ALTER TABLE t ADD CONSTRAINT t_b_ck CHECK (b >= 0) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT t_b_ck;
SET lock_timeout TO '1s';
`)
    assert.deepEqual(lintSql(text).problems, [])
  })

  test('same-file tables may be altered, renamed or given any constraint', () => {
    const text = expand(`CREATE TABLE fresh (id int);
ALTER TABLE fresh ADD COLUMN n int NOT NULL;
ALTER TABLE fresh ADD CONSTRAINT fresh_fk FOREIGN KEY (n) REFERENCES other (id);
ALTER TABLE fresh RENAME COLUMN n TO m;
`)
    assert.deepEqual(lintSql(text).problems, [])
  })
})

describe('migrate: DML only after the tenant context', () => {
  test('UPDATE or INSERT before set_config(gremion.customer_id, .., true) is refused', () => {
    assert.deepEqual(rules(migrate('UPDATE t SET a = 1;\n')), [RULES.dmlBeforeTenant])
    assert.deepEqual(rules(migrate('INSERT INTO t (a) VALUES (1);\n')), [RULES.dmlBeforeTenant])
  })

  test('after set_config(.., true) or SET LOCAL of the GUC, UPDATE and INSERT pass', () => {
    assert.deepEqual(rules(migrate("SELECT set_config('gremion.customer_id', '0190a000-0000-7000-8000-000000000001', true);\nUPDATE t SET a = 1 WHERE a IS NULL;\nINSERT INTO t (a) VALUES (2);\n")), [])
    assert.deepEqual(rules(migrate("SET LOCAL gremion.customer_id = '0190a000-0000-7000-8000-000000000001';\nUPDATE t SET a = 1;\n")), [])
  })

  test('a session-wide set_config (false) or another GUC is not the tenant context', () => {
    assert.deepEqual(rules(migrate("SELECT set_config('gremion.customer_id', 'x', false);\nUPDATE t SET a = 1;\n")), [RULES.notAllowed, RULES.dmlBeforeTenant])
    assert.deepEqual(rules(migrate("SELECT set_config('app.other', 'x', true);\nUPDATE t SET a = 1;\n")), [RULES.notAllowed, RULES.dmlBeforeTenant])
  })

  test('DELETE and destructive DDL stay refused in migrate', () => {
    assert.deepEqual(rules(migrate("SELECT set_config('gremion.customer_id', 'x', true);\nDELETE FROM t;\nDROP TABLE u;\n")), [RULES.delete, RULES.drop])
  })
})

describe('contract: statements and the identifiers they drop', () => {
  test('destructive statements pass the statement lint and report what they drop or tighten', () => {
    const r = lintSql(`-- gremion:phase contract
-- gremion:contract-after dist-v1.2.0
${LT}ALTER TABLE t DROP COLUMN legacy_flag, ALTER COLUMN kind SET NOT NULL;
ALTER TABLE t RENAME COLUMN old_name TO new_name;
DROP TABLE IF EXISTS gov.obsolete_things, other_things CASCADE;
DROP FUNCTION gov.old_fn(int);
ALTER TABLE t ALTER COLUMN amount TYPE bigint;
`)
    assert.deepEqual(r.problems, [])
    assert.equal(r.contractAfter, 'dist-v1.2.0')
    assert.deepEqual(r.dropped.sort(), ['amount', 'kind', 'legacy_flag', 'obsolete_things', 'old_fn', 'old_name', 'other_things'])
  })

  test('a contract still needs lock_timeout', () => {
    assert.deepEqual(rules('-- gremion:phase contract\n-- gremion:contract-after dist-v1.0.0\nDROP TABLE t;\n'), [RULES.noLockTimeout])
  })
})

// ── TDD 2: the contract rule against a real repository ──────────────────────

const TMP_ROOT = process.env.GREMION_TEST_TMPDIR || tmpdir()
const repos = []
after(() => {
  for (const r of repos) rmSync(r, { recursive: true, force: true })
})

function g(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t075@example.invalid', '-c', 'user.name=t075', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function repo() {
  mkdirSync(TMP_ROOT, { recursive: true })
  const dir = mkdtempSync(join(TMP_ROOT, 't075-contract-'))
  repos.push(dir)
  g(dir, 'init', '-q')
  mkdirSync(join(dir, 'db', 'migrations'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const q = "SELECT legacy_flag FROM t"\n')
  writeFileSync(join(dir, 'db', 'migrations', '0001_t.sql'), 'CREATE TABLE t (legacy_flag boolean);\n')
  g(dir, 'add', '-A')
  g(dir, 'commit', '-q', '-m', 'v1')
  return dir
}

const FILE = 'db/migrations/0002_drop_legacy.sql'
const contract = (cwd, tag, dropped = ['legacy_flag']) => checkContract({ cwd, file: FILE, contractAfter: tag, dropped, excludeDirs: ['db/migrations'] }).map((p) => p.rule)

describe('contract: the newest reachable dist-v* tag that no longer reads what is dropped (TDD 2)', () => {
  test('no dist-v* tag at all: every contract fails until the first release', () => {
    const dir = repo()
    assert.deepEqual(contract(dir, 'dist-v1.0.0'), [RULES.noDistTag])
  })

  test('absent marker', () => {
    const dir = repo()
    g(dir, 'tag', 'dist-v1.0.0')
    assert.deepEqual(contract(dir, null), [RULES.contractAfterMissing])
  })

  test('a tag that does not exist, and one not reachable from HEAD', () => {
    const dir = repo()
    g(dir, 'tag', 'dist-v1.0.0')
    assert.deepEqual(contract(dir, 'dist-v9.9.9'), [RULES.contractAfterUnknown])
    g(dir, 'checkout', '-q', '-b', 'side')
    writeFileSync(join(dir, 'src', 'side.ts'), 'x\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'side')
    g(dir, 'tag', 'dist-v1.1.0')
    g(dir, 'checkout', '-q', 'main')
    assert.deepEqual(contract(dir, 'dist-v1.1.0'), [RULES.contractAfterNotAncestor])
  })

  test('a tag that already contains the contract file', () => {
    const dir = repo()
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const q = "SELECT 1"\n')
    writeFileSync(join(dir, FILE), 'ALTER TABLE t DROP COLUMN legacy_flag;\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'v2')
    g(dir, 'tag', 'dist-v1.0.0')
    assert.deepEqual(contract(dir, 'dist-v1.0.0'), [RULES.contractAfterContainsFile])
  })

  test('an older tag while a newer reachable one exists', () => {
    const dir = repo()
    g(dir, 'tag', 'dist-v1.0.0')
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const q = "SELECT 1"\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'v2')
    g(dir, 'tag', 'dist-v1.10.0')
    g(dir, 'tag', 'dist-v1.9.0', 'HEAD~1')
    assert.deepEqual(contract(dir, 'dist-v1.9.0'), [RULES.contractAfterNotNewest])
  })

  test('an identifier still referenced in the tag tree fails; migration dirs and fixtures do not count', () => {
    const dir = repo()
    mkdirSync(join(dir, 'test', 'fixtures'), { recursive: true })
    writeFileSync(join(dir, 'test', 'fixtures', 'f.sql'), 'SELECT legacy_flag;\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'fixture')
    g(dir, 'tag', 'dist-v1.0.0')
    const problems = checkContract({ cwd: dir, file: FILE, contractAfter: 'dist-v1.0.0', dropped: ['legacy_flag'], excludeDirs: ['db/migrations'] })
    assert.deepEqual(problems.map((p) => p.rule), [RULES.identifierReferenced])
    assert.match(problems[0].message, /legacy_flag is still referenced in dist-v1\.0\.0: src\/app\.ts$/)
  })

  test('valid: newest reachable tag, file absent in it, nothing dropped still read', () => {
    const dir = repo()
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const q = "SELECT 1"\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'stop reading legacy_flag')
    g(dir, 'tag', 'dist-v1.0.0')
    writeFileSync(join(dir, FILE), 'ALTER TABLE t DROP COLUMN legacy_flag;\n')
    g(dir, 'add', '-A')
    g(dir, 'commit', '-q', '-m', 'contract')
    assert.deepEqual(contract(dir, 'dist-v1.0.0'), [])
  })
})
