// TASK-062 TDD 4 (Q1 default) — the LocalePreferencePort seam.
//
// Every DB write for the signed-in person's language preference goes through
// this port, never through ad-hoc SQL at the call site (same shape as
// packages/storage's StorageBackend seam). `idt.preference` does not exist on
// `main` yet (no P1 unit owns the DB-IDT-PREFERENCE DDL before the kernel API,
// TASK-080/W10) — see the brief's Q1. This file ships the interface and the
// in-memory test double; the reference pg adapter + a test-only fixture that
// applies the idt.preference DDL verbatim are NOT in this commit (residual,
// tracked in the TASK-062 report).
//
export type PersonLocale = 'de' | 'en' | 'follow_customer'
export type CustomerDefaultLocale = 'de' | 'en'

export interface LocalePreferenceRow {
  locale: PersonLocale
  rowVersion: number
  updatedByKind: 'person' | 'system'
}

/** The seam every adapter (in-memory test double, and eventually pg) satisfies. */
export interface LocalePreferencePort {
  /** Null when the person has no preference row yet (never switched). */
  get(customerId: string, personId: string): Promise<LocalePreferenceRow | null>
  /** Upserts; row_version starts at 1 and increments by 1 on every call. */
  set(customerId: string, personId: string, locale: PersonLocale): Promise<LocalePreferenceRow>
  getCustomerDefault(customerId: string): Promise<CustomerDefaultLocale>
}

export const LOCALE_PREFERENCE_BACKENDS = ['memory'] as const
export type LocalePreferenceBackendName = (typeof LOCALE_PREFERENCE_BACKENDS)[number]

export interface LocalePreferenceConfig {
  backend: LocalePreferenceBackendName
  /** Per-customer default when the test fixture does not set one; 'de' otherwise. */
  customerDefaults?: Record<string, CustomerDefaultLocale>
}

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
    const key = this.key(customerId, personId)
    const existing = this.rows.get(key)
    const row: LocalePreferenceRow = {
      locale,
      rowVersion: (existing?.rowVersion ?? 0) + 1,
      updatedByKind: 'person'
    }
    this.rows.set(key, row)
    return row
  }

  async getCustomerDefault(customerId: string): Promise<CustomerDefaultLocale> {
    return this.customerDefaults[customerId] ?? 'de'
  }
}

let activePort: LocalePreferencePort | null = null

export function configureLocalePreference(config: LocalePreferenceConfig): void {
  if (config.backend !== 'memory') {
    throw new Error(`LocalePreferencePort backend '${config.backend}' has no adapter yet (residual: pg)`)
  }
  activePort = new MemoryLocalePreferencePort(config.customerDefaults ?? {})
}

export function getLocalePreferencePort(): LocalePreferencePort {
  if (!activePort) throw new Error('LocalePreferencePort not configured — call configureLocalePreference() first')
  return activePort
}

export function resetLocalePreferenceForTest(): void {
  activePort = null
}
