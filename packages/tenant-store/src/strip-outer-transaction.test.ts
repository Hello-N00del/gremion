import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { splitStatements, stripOuterTransaction } from './strip-outer-transaction.js'

/**
 * The release-1 B22 rule, kept here as the RED guard: a multi-line (/m) regex
 * whose ^ also matches a line INSIDE a DO $$ ... $$ body, so a plpgsql
 * `BEGIN` / `COMMIT;` line is cut out of a function body.
 */
const b22Strip = (text: string) =>
  text.replace(/^\s*BEGIN\s*;?\s*$/im, '').replace(/^\s*COMMIT\s*;\s*$/im, '')

const DO_BLOCK = `-- no outer wrapper
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'x') THEN
    CREATE TYPE x AS ENUM ('a');
  END IF;
END
$$;
`

const WRAPPED = `-- header comment
BEGIN;
CREATE TABLE a (id int);
CREATE FUNCTION f() RETURNS trigger AS $body$
BEGIN
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;
COMMIT;
-- trailing comment
`

const PROC_WITH_COMMIT = `CREATE PROCEDURE p() LANGUAGE plpgsql AS $$
BEGIN
  COMMIT;
END
$$;
`

const implementations = [
  ['stripOuterTransaction', stripOuterTransaction],
  // The RED guard: run these with IMPL=b22 to watch the old rule fail them.
  ...(process.env.IMPL === 'b22' ? [['b22 /im regex', b22Strip] as const] : []),
] as const

describe.each(implementations)('%s', (_name, strip) => {
  it('keeps a DO $$ body whole when the file has no outer wrapper', () => {
    expect(strip(DO_BLOCK)).toBe(DO_BLOCK)
  })

  it('removes the outer BEGIN;/COMMIT; and keeps the inner plpgsql BEGIN', () => {
    const out = strip(WRAPPED)
    expect(out).not.toMatch(/^BEGIN;$/m)
    expect(out).not.toMatch(/^COMMIT;$/m)
    expect(out).toContain('$body$\nBEGIN\n  RETURN NEW;\nEND;\n$body$')
    expect(out).toContain('CREATE TABLE a (id int);')
    expect(out).toContain('-- trailing comment')
  })

  it('keeps a COMMIT; inside a procedure body', () => {
    expect(strip(PROC_WITH_COMMIT)).toBe(PROC_WITH_COMMIT)
  })
})

describe('stripOuterTransaction rules', () => {
  it('accepts the other spellings of the wrapper', () => {
    expect(stripOuterTransaction('begin transaction;\nSELECT 1;\nend work;\n')).toBe('\nSELECT 1;\n\n')
    expect(stripOuterTransaction('START TRANSACTION;SELECT 1;COMMIT')).toBe('SELECT 1;')
  })

  it('refuses a transaction-control statement left inside the body', () => {
    expect(() => stripOuterTransaction('BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\nCOMMIT;\n')).toThrow(/transaction control.*COMMIT/)
    expect(() => stripOuterTransaction('SELECT 1;\nROLLBACK;\n')).toThrow(/transaction control.*ROLLBACK/)
    expect(() => stripOuterTransaction('SAVEPOINT s; SELECT 1;')).toThrow(/transaction control/)
  })

  it('refuses an unbalanced wrapper', () => {
    expect(() => stripOuterTransaction('BEGIN;\nSELECT 1;\n')).toThrow(/unbalanced/)
    expect(() => stripOuterTransaction('SELECT 1;\nCOMMIT;\n')).toThrow(/transaction control|unbalanced/)
  })

  it('does not split on a ; inside strings, identifiers, comments or dollar quotes', () => {
    const text = `SELECT 'a;b', E'c\\';d', "e;f" /* g; /* nested; */ h; */ , $x$ i; $x$, $1;\n-- j;\nSELECT 2`
    expect(splitStatements(text).map((s) => s.code)).toEqual([
      `SELECT 'a;b', E'c\\';d', "e;f"   , $x$ i; $x$, $1`,
      'SELECT 2',
    ])
  })

  it('keeps a SQL-standard BEGIN ATOMIC ... END body (with a CASE inside) as one statement', () => {
    const text = 'CREATE FUNCTION f(x int) RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n  SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END;\n  SELECT 2;\nEND;\nSELECT 3;'
    expect(splitStatements(text)).toHaveLength(2)
    expect(stripOuterTransaction(text)).toBe(text)
  })

  it('refuses an unterminated string, dollar quote or block comment', () => {
    expect(() => splitStatements("SELECT 'x")).toThrow(/unterminated/)
    expect(() => splitStatements('SELECT $a$ x')).toThrow(/unterminated/)
    expect(() => splitStatements('SELECT /* x')).toThrow(/unterminated/)
  })

  it('handles the kernel migrations that carry a wrapper (041, 043): wrapper out, plpgsql bodies kept', () => {
    for (const f of ['041_protocol_resolution_global_nr_unique.sql', '043_audit_log_hash_chain.sql']) {
      const path = fileURLToPath(new URL(`../../../gremion-ui/migrations/${f}`, import.meta.url))
      const text = readFileSync(path, 'utf8')
      const out = stripOuterTransaction(text)
      const bodies = (s: string) => (s.match(/\$\$[\s\S]*?\$\$/g) ?? []).join('\n')
      expect(bodies(out)).toBe(bodies(text))
      expect(splitStatements(out).some((s) => /^(BEGIN|COMMIT)$/i.test(s.code))).toBe(false)
      expect(splitStatements(text).length - splitStatements(out).length).toBe(2)
    }
  })
})
