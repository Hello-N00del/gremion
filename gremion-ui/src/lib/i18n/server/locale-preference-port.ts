// TASK-062 TDD 4 (Q1 default) — the LocalePreferencePort seam.
//
// Every DB write for the signed-in person's language preference goes through
// this port, never through ad-hoc SQL at the call site (same shape as
// packages/storage's StorageBackend seam). Two adapters:
//   - 'memory': the in-process test double;
//   - 'pg': the reference adapter (locale-preference-pg.ts) issuing the SCHEMA
//     SQL against idt.preference / idt.customer_setting.
// Both pass one contract suite (locale-preference-contract.ts).
//
// Production binding is NOT done here: `idt.preference` does not exist on
// `main` (no P1 unit owns the DB-IDT-PREFERENCE DDL before the kernel API,
// TASK-080/W10). "Bind the port to the kernel API; the idt.preference DDL
// ships with the idt schema" is TASK-080/038's line (brief Q1). Until then
// nothing configures a port in the running app, personIdOf() returns null
// (Q2) and the cookie decides.
import type postgres from 'postgres'
import { KernelApiLocalePreferencePort, type KernelApiLocaleConfig } from './locale-preference-kernel-api'
import { PgLocalePreferencePort } from './locale-preference-pg'

export type PersonLocale = 'de' | 'en' | 'follow_customer'
export type CustomerDefaultLocale = 'de' | 'en'

const PERSON_LOCALES: readonly PersonLocale[] = ['de', 'en', 'follow_customer']

export interface LocalePreferenceRow {
  locale: PersonLocale
  rowVersion: number
  updatedByKind: 'person' | 'system'
  /** The idt.person_id that made this write. Null only for a 'system' write with no actor. */
  updatedBy: string | null
}

/** The seam every adapter (in-memory test double, pg) satisfies. */
export interface LocalePreferencePort {
  /** Null when the person has no preference row yet (never switched). */
  get(customerId: string, personId: string): Promise<LocalePreferenceRow | null>
  /** Upserts; row_version starts at 1 and increments by 1 on every call. Rejects an unknown locale. */
  set(customerId: string, personId: string, locale: PersonLocale): Promise<LocalePreferenceRow>
  getCustomerDefault(customerId: string): Promise<CustomerDefaultLocale>
}

export const LOCALE_PREFERENCE_BACKENDS = ['memory', 'pg', 'kernel-api'] as const
export type LocalePreferenceBackendName = (typeof LOCALE_PREFERENCE_BACKENDS)[number]

export type LocalePreferenceConfig =
  | {
      backend: 'memory'
      /** Per-customer default when the test fixture does not set one; 'de' otherwise. */
      customerDefaults?: Record<string, CustomerDefaultLocale>
    }
  | { backend: 'pg'; sql: postgres.Sql }
  /** TASK-080-a G11: the kernel API owns idt; this asks it as the signed-in person. */
  | ({ backend: 'kernel-api' } & KernelApiLocaleConfig)

/** Keyed by `${customerId}::${personId}` — never by personId alone, so a
 *  lookup under the wrong customerId cannot see another customer's row
 *  (the in-memory stand-in for the real adapter's RLS). */
class MemoryLocalePreferencePort implements LocalePreferencePort {
  private rows = new Map<string, LocalePreferenceRow>()
  constructor(private readonly customerDefaults: Record<string, CustomerDefaultLocale>) {}

  private key(customerId: string, personId: string): string {
    return `${customerId}::${personId}`
  }

  async get(customerId: string, personId: string): Promise<LocalePreferenceRow | null> {
    return this.rows.get(this.key(customerId, personId)) ?? null
  }

  async set(customerId: string, personId: string, locale: PersonLocale): Promise<LocalePreferenceRow> {
    // Mirrors preference_locale_check: an unknown value is refused, not stored.
    if (!PERSON_LOCALES.includes(locale)) throw new Error(`unsupported locale preference '${String(locale)}'`)
    const key = this.key(customerId, personId)
    const existing = this.rows.get(key)
    const row: LocalePreferenceRow = {
      locale,
      rowVersion: (existing?.rowVersion ?? 0) + 1,
      updatedByKind: 'person',
      updatedBy: personId
    }
    this.rows.set(key, row)
    return row
  }

  async getCustomerDefault(customerId: string): Promise<CustomerDefaultLocale> {
    return this.customerDefaults[customerId] ?? 'de'
  }
}

let activePort: LocalePreferencePort | null = null

export function createLocalePreferencePort(config: LocalePreferenceConfig): LocalePreferencePort {
  switch (config.backend) {
    case 'memory':
      return new MemoryLocalePreferencePort(config.customerDefaults ?? {})
    case 'pg':
      return new PgLocalePreferencePort(config.sql)
    case 'kernel-api':
      return new KernelApiLocalePreferencePort(config)
    default: {
      const unknown: never = config
      throw new Error(`unknown LocalePreferencePort backend ${JSON.stringify(unknown)}`)
    }
  }
}

export function configureLocalePreference(config: LocalePreferenceConfig): void {
  activePort = createLocalePreferencePort(config)
}

/** True once an adapter is bound. Lets the read path skip lookups quietly while none is (Q1). */
export function isLocalePreferenceConfigured(): boolean {
  return activePort !== null
}

export function getLocalePreferencePort(): LocalePreferencePort {
  if (!activePort) throw new Error('LocalePreferencePort not configured — call configureLocalePreference() first')
  return activePort
}

export function resetLocalePreferenceForTest(): void {
  activePort = null
}
