/**
 * Log-retention tiers: the ONE place the numbers live (R29-RETENTION-30-K).
 *
 * Operator decision [D R29-I6] (2026-09-30): no log class is kept longer than
 * 30 days. The product's daily purge tick (`hooks.server.ts`) adds up to 24 h to
 * whatever window is configured, so a tier that the tick enforces is capped at
 * 29 days (29 d + 24 h = 30 d). Defaults follow the retention catalogue
 * (security/audit 27 d, application 28 d, access 14 d;
 * `docs/compliance/retention-catalogue.md`).
 *
 * `security_nopii_logs_days` keeps cap 30: an operator-set value of 30 [R31-I4a]
 * must stay valid. Its purge consumer does not exist in this repo yet (named
 * residual; nothing reads the value), so the +24 h tick term does not apply to it.
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

/** The purge tick runs daily, so a record can outlive its window by this much. */
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
 * Reader-facing caveat per tier, or `null` when a gremion-ui purge consumer
 * enforces the window. Today only `security_logs_days` has one (the daily
 * `auditRetentionTick` in `hooks.server.ts`); the other three are configuration
 * until a consumer exists, and a guard in `retention-tiers.test.ts` ties `null`
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
  security_logs_days: null,
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
