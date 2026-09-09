// src/lib/server/observability/tenant-log.ts
// P2.1c (T19, §7.10 half 2) — tenant-id-tagged structured logging seam.
//
// Fleet logs must be ATTRIBUTABLE: every tenant-scoped log line carries the
// canonical registry tenant id so a single log stream from N co-resident
// tenants can be filtered by `tenant`. `tlog(level, msg, fields)` emits ONE
// single-line JSON record and merges `{ tenant: getTenantOrNull()?.id ?? null }`
// (the non-throwing read — logging must never fail-closed on a missing context;
// out-of-request callers legitimately log with `tenant: null`).
//
// PII-SAFE BY CONSTRUCTION (§7.10): the seam drops any caller-supplied field
// whose key looks like an email or a credential/token. A log line can never
// leak those even if a caller passes them by mistake. The drop is silent on the
// hot path; the denylist is asserted by the unit test.
//
// This is a SEAM, not a repo-wide console.* migration (that is the explicit
// follow-on, out of scope here). Metrics are NOT implemented here: the §7.10
// "metrics" clause is satisfied at S3 level by the health pane (T18) + these
// tagged logs; a real metrics pipeline is Pillar-1 Phase-2/OTel territory (the
// tracer port landed unwired in P0.5).
import { getTenantOrNull } from '$lib/server/tenant/context'

export type TLogLevel = 'info' | 'warn' | 'error'

/** A log field value — JSON-serialisable scalars only (no nested objects). */
export type TLogFieldValue = string | number | boolean | null

/**
 * Field keys forbidden in a structured log record. Matched case-insensitively
 * as a SUBSTRING so `userEmail`, `access_token`, `refreshToken`,
 * `client_secret`, `Authorization`, `passwordHash`, etc. are all caught. Kept
 * deliberately small and obvious — the test pins the exact set.
 */
const PII_KEY_DENYLIST = [
  'email',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
] as const

function isDeniedKey(key: string): boolean {
  const k = key.toLowerCase()
  return PII_KEY_DENYLIST.some((bad) => k.includes(bad))
}

/**
 * Emit one tenant-tagged structured log record on a single line.
 *
 * The record is `{ level, msg, tenant, ...safeFields }` where `tenant` is the
 * active tenant id or `null` outside a request/`runWithTenant` scope. Any field
 * whose key is on the PII denylist is dropped (never serialised). `level` and
 * `msg` cannot be shadowed by `fields` — the structural keys win.
 */
export function tlog(
  level: TLogLevel,
  msg: string,
  fields: Readonly<Record<string, TLogFieldValue>> = {},
): void {
  const safeFields: Record<string, TLogFieldValue> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (isDeniedKey(key)) continue
    // Never let a caller field shadow the structural keys.
    if (key === 'level' || key === 'msg' || key === 'tenant') continue
    safeFields[key] = value
  }

  const record = {
    level,
    msg,
    tenant: getTenantOrNull()?.id ?? null,
    ...safeFields,
  }

  const line = JSON.stringify(record)
  // Route to the matching console method so existing stderr/stdout splitting
  // and log-level filtering keep working.
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}
