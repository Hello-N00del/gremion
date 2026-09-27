// TASK-062 (Q1 default) — the reference pg adapter for LocalePreferencePort.
//
// It issues the SCHEMA SQL against DB-IDT-PREFERENCE / DB-IDT-CUSTOMERSETTING
// (SCHEMA-gremion §IDT): every call is one transaction whose FIRST statement is
// set_config('gremion.customer_id', …, true), so the tables' RLS policies
// (customer_id = idt.current_customer_id()) scope every read and write. The
// write is an upsert on person_id; on update the table's touch_row trigger
// bumps row_version by one and stamps updated_at, and this adapter records
// updated_by_kind='person' with the acting person.
//
// Nothing binds this adapter in production yet: the kernel API (TASK-080) is
// the idt writer, and the idt.preference DDL ships with the idt schema
// (TASK-038/080). Until then it is exercised by the contract suite against a
// test-only fixture that applies the DDL verbatim.
import type postgres from 'postgres'
import type { CustomerDefaultLocale, LocalePreferencePort, LocalePreferenceRow, PersonLocale } from './locale-preference-port'

type Sql = postgres.Sql

interface PreferenceRecord {
  locale: PersonLocale
  row_version: string | number | bigint
  updated_by_kind: 'person' | 'system'
  updated_by: string | null
}

function toRow(record: PreferenceRecord): LocalePreferenceRow {
  return {
    locale: record.locale,
    rowVersion: Number(record.row_version),
    updatedByKind: record.updated_by_kind,
    updatedBy: record.updated_by
  }
}

export class PgLocalePreferencePort implements LocalePreferencePort {
  constructor(private readonly sql: Sql) {}

  private inCustomer<T>(customerId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT set_config('gremion.customer_id', ${customerId}, true)`
      return work(tx)
    }) as Promise<T>
  }

  async get(customerId: string, personId: string): Promise<LocalePreferenceRow | null> {
    const rows = await this.inCustomer(customerId, (tx) => tx<PreferenceRecord[]>`
      SELECT locale, row_version, updated_by_kind, updated_by
        FROM idt.preference
       WHERE person_id = ${personId}`)
    return rows[0] ? toRow(rows[0]) : null
  }

  async set(customerId: string, personId: string, locale: PersonLocale): Promise<LocalePreferenceRow> {
    const rows = await this.inCustomer(customerId, (tx) => tx<PreferenceRecord[]>`
      INSERT INTO idt.preference
             (person_id, customer_id, locale, created_by_kind, created_by, updated_by_kind, updated_by)
      VALUES (${personId}, ${customerId}, ${locale}, 'person', ${personId}, 'person', ${personId})
      ON CONFLICT (person_id) DO UPDATE
         SET locale = EXCLUDED.locale,
             updated_by_kind = 'person',
             updated_by = EXCLUDED.updated_by
      RETURNING locale, row_version, updated_by_kind, updated_by`)
    const row = rows[0]
    if (!row) throw new Error('idt.preference upsert returned no row')
    return toRow(row)
  }

  async getCustomerDefault(customerId: string): Promise<CustomerDefaultLocale> {
    const rows = await this.inCustomer(customerId, (tx) => tx<{ default_locale: CustomerDefaultLocale }[]>`
      SELECT default_locale FROM idt.customer_setting WHERE customer_id = ${customerId}`)
    // No customer_setting row yet: the column default, 'de' (UX-015).
    return rows[0]?.default_locale ?? 'de'
  }
}
