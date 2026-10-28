/**
 * Log-retention tiers: the ONE place the numbers live (R29-RETENTION-30-K).
 *
 * Operator decision [D R29-I6] (2026-09-30): no log class is kept longer than
 * 30 days. A daily purge adds up to 24 h to a window, so a tier a daily purge
 * would enforce is capped at 29 days (29 d + 24 h = 30 d). Defaults follow the
 * retention catalogue (security 27 d, application 28 d, access 14 d;
 * `docs/compliance/retention-catalogue.md`) and equal what the registry renders
 * into the log store's own retention (`packages/retention`; a test ties them).
 *
 * NOTHING in gremion-ui reads these values to delete anything (TASK-033-a): the
 * four tiers are LOG-STORE windows, shown read-only. The kernel's hash-chained
 * `audit_log` table is not one of them: it is a governance record (RC-GOV-CHAIN,
 * operator decision 2026-10-28), no timer purges it, and the application role
 * can only append to it (`AUDIT_LOG_RECORD_DE`).
 *
 * `security_nopii_logs_days` keeps cap 30: an operator-set value of 30 [R31-I4a]
 * must stay valid. It has no registry class (catalogue gap G4).
 *
 * Pure and client-safe (no `$lib/server`, no fs): config.ts clamps through it,
 * the settings API builds its zod bounds from it, TabRetention.svelte imports
 * it for the client limits. Do not copy these numbers anywhere else; a test
 * (`retention-tiers.test.ts`) fails if a surface keeps a private copy.
 */

export type RetentionField =
  | 'access_logs_days'
  | 'app_logs_days'
  | 'security_logs_days'
  | 'security_nopii_logs_days'

export const RETENTION_FIELDS: readonly RetentionField[] = [
  'access_logs_days',
  'app_logs_days',
  'security_logs_days',
  'security_nopii_logs_days',
]

/** Operator ceiling [D R29-I6]: no log class outlives this many days. */
export const OPERATOR_CEILING_DAYS = 30

/** A daily purge lets a record outlive its window by this much (the cap leaves room for it). */
export const PURGE_TICK_DAYS = 1

export const RETENTION_DEFAULTS: Readonly<Record<RetentionField, number>> = {
  access_logs_days: 14,
  app_logs_days: 28,
  security_logs_days: 27,
  security_nopii_logs_days: 27,
}

export const RETENTION_CAPS: Readonly<Record<RetentionField, number>> = {
  access_logs_days: OPERATOR_CEILING_DAYS - PURGE_TICK_DAYS,
  app_logs_days: OPERATOR_CEILING_DAYS - PURGE_TICK_DAYS,
  security_logs_days: OPERATOR_CEILING_DAYS - PURGE_TICK_DAYS,
  security_nopii_logs_days: OPERATOR_CEILING_DAYS,
}

/** Reader-facing name of [D R29-I6]: documents and UI never show the internal id. */
export const OPERATOR_DECISION_DE = 'Betreiberentscheidung vom 30.09.2026'

/**
 * Reader-facing statement about the kernel's audit table (RC-GOV-CHAIN). The
 * deletion concept, the settings tab and the compliance documents say this and
 * nothing else about it: no deletion period, no timer.
 */
export const AUDIT_LOG_RECORD_DE =
  'Die Audit-Tabelle der Anwendung (hash-verkettet) ist ein Governance-Datensatz (RC-GOV-CHAIN): ' +
  'Sie wird von keinem Zeitgeber gelöscht, und die Anwendung darf Einträge nur anhängen, nicht ändern oder löschen.'

/**
 * Reader-facing caveat per tier, or `null` when a gremion-ui purge consumer
 * enforces the window. No tier has one (TASK-033-a): the application deletes
 * nothing by these values, and a guard in `retention-tiers.test.ts` ties `null`
 * to what `hooks.server.ts` actually reads. Wording follows
 * `docs/log-retention-policy.md` (what bounds those logs today): the edge logs
 * are rotated by the infrastructure, independent of these values; the
 * application's container logs are size-bounded only.
 */
export const RETENTION_CAVEATS: Readonly<Record<RetentionField, string | null>> = {
  access_logs_days:
    'Konfigurationswert: Die Anwendung löscht nach diesem Wert derzeit nicht selbst. ' +
    'Die Zugriffsprotokolle der Infrastruktur (Traefik/Vector) werden unabhängig davon ' +
    'durch Protokollrotation auf höchstens 30 Tage begrenzt.',
  app_logs_days:
    'Konfigurationswert: Die Anwendung löscht nach diesem Wert derzeit nicht selbst. ' +
    'Die Container-Protokolle der Anwendung sind nur in ihrer Größe begrenzt, nicht zeitlich.',
  security_logs_days:
    'Konfigurationswert: Die Anwendung löscht nach diesem Wert nicht selbst; er ist das Fenster des Protokollspeichers. ' +
    'Die Audit-Tabelle der Anwendung ist davon ausgenommen (RC-GOV-CHAIN): Sie wird von keinem Zeitgeber gelöscht.',
  security_nopii_logs_days:
    'Konfigurationswert: Die Anwendung löscht nach diesem Wert derzeit nicht selbst. ' +
    'Soweit solche Protokolle in der Infrastruktur (Traefik/Vector) anfallen, begrenzt deren ' +
    'Protokollrotation sie unabhängig davon auf höchstens 30 Tage.',
}

/**
 * Clamp a stored or submitted value into 1..cap. A non-number (missing, null,
 * string) or NaN becomes the default (never NaN, which JSON.stringify would
 * persist as null); +Infinity clamps to the cap and -Infinity to 1; a
 * fractional value is floored so it can never round past the cap.
 */
export function clampRetentionDays(field: RetentionField, value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return RETENTION_DEFAULTS[field]
  if (value === Infinity) return RETENTION_CAPS[field]
  if (value === -Infinity) return 1
  return Math.min(RETENTION_CAPS[field], Math.max(1, Math.floor(value)))
}
