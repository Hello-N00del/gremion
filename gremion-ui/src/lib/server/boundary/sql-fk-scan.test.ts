import { describe, it, expect } from 'vitest'
import { scanSqlForCrossSchemaFk, type FkAllowEntry } from './sql-fk-scan'

const NO_ALLOW: FkAllowEntry[] = []

describe('scanSqlForCrossSchemaFk', () => {
  it('flags an unqualified REFERENCES (=public) from a finance-schema table', () => {
    const sql = `CREATE TABLE finance.widget (
  id BIGINT PRIMARY KEY,
  org_unit_id UUID NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT
);`
    const v = scanSqlForCrossSchemaFk('099_widget.sql', sql, NO_ALLOW)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({
      file: '099_widget.sql', table: 'finance.widget', ref: 'public.org_units', line: 3,
    })
  })

  it('flags a qualified public.* reference from finance and finance.* from public', () => {
    const sql = `CREATE TABLE finance.a (x UUID REFERENCES public.users(id));
CREATE TABLE b (y BIGINT REFERENCES finance.booking(id));`
    const v = scanSqlForCrossSchemaFk('099.sql', sql, NO_ALLOW)
    expect(v.map((x) => `${x.table}->${x.ref}`).sort()).toEqual(
      ['finance.a->public.users', 'public.b->finance.booking'])
  })

  it('does not flag same-schema references (finance->finance, public->public)', () => {
    const sql = `CREATE TABLE finance.a (x BIGINT REFERENCES finance.b(id));
CREATE TABLE c (y UUID REFERENCES org_units(id));
ALTER TABLE finance.booking ADD COLUMN fy BIGINT REFERENCES finance.fiscal_year(id);`
    expect(scanSqlForCrossSchemaFk('001.sql', sql, NO_ALLOW)).toEqual([])
  })

  it('honors the allowlist exactly (file + table + ref triple)', () => {
    const sql = `CREATE TABLE finance.finance_unit (
  org_unit_id UUID NOT NULL UNIQUE REFERENCES org_units(id) ON DELETE RESTRICT
);`
    const allow: FkAllowEntry[] = [
      { file: '013_finance_schema.sql', table: 'finance.finance_unit', ref: 'public.org_units' },
    ]
    expect(scanSqlForCrossSchemaFk('013_finance_schema.sql', sql, allow)).toEqual([])
    // same allow entry must NOT cover a different file
    expect(scanSqlForCrossSchemaFk('099_new.sql', sql, allow)).toHaveLength(1)
  })

  it('ignores SQL line comments', () => {
    const sql = `CREATE TABLE finance.a (
  -- x UUID REFERENCES org_units(id)
  x BIGINT
);`
    expect(scanSqlForCrossSchemaFk('001.sql', sql, NO_ALLOW)).toEqual([])
  })

  it('handles ALTER TABLE ADD CONSTRAINT', () => {
    const sql = `ALTER TABLE finance.booking
  ADD CONSTRAINT fk_x FOREIGN KEY (org_unit_id) REFERENCES public.org_units(id);`
    const v = scanSqlForCrossSchemaFk('099.sql', sql, NO_ALLOW)
    expect(v).toHaveLength(1)
    expect(v[0].table).toBe('finance.booking')
  })
})
