// Tenant-id and key validation shared by every backend.
//
// assertTenantId is the fail-closed gate (spec-b S2): a missing, empty or
// malformed tenant id THROWS SYNCHRONOUSLY — there is no default and no
// fallback tenant. It is an allowlist, not a denylist: a lowercase canonical
// UUID (the registry's `tenant.id`, which Postgres renders lowercase) or the
// legacy literal 'default' (Q5; see default-tenant.ts in gremion-ui). That
// rejects `/`, `\`, `..`, whitespace and every other path-significant input by
// construction. An upper-case UUID is refused rather than folded: folding would
// be harmless, but accepting two spellings of one tenant would split its data
// across two segments.

import { posix } from 'node:path'

/** The local backend's in-flight temp files are `.<name>.<uuid>.partial`.
 *  Such names are reserved on every backend so list() can skip them safely. */
export const PARTIAL_NAME_RE = /^\..+\.[0-9a-f-]{36}\.partial$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Q5 residual: the pre-registry single-tenant id. Accepted as an explicit
 *  literal until the zero-tenant-boot unit retires it. */
export const LEGACY_DEFAULT_TENANT_ID = 'default'

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return JSON.stringify(value)
  return typeof value
}

/** Validate a tenant id or throw synchronously. Returns the id unchanged. */
export function assertTenantId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `storage: no tenant id (got ${describeValue(value)}) — getStorageFor() requires an ` +
        'explicit tenant; there is no default tenant (fail-closed)',
    )
  }
  if (value === LEGACY_DEFAULT_TENANT_ID || UUID_RE.test(value)) return value
  throw new TypeError(
    `storage: invalid tenant id ${describeValue(value)} — expected a lowercase canonical ` +
      `UUID or the legacy literal '${LEGACY_DEFAULT_TENANT_ID}'`,
  )
}

/** Normalise a caller's tenant-relative path and compose `<tenantId>/<path>`.
 *  Throws (synchronously) on anything that is not a plain relative file path. */
export function composeKey(backend: string, tenantId: string, relPath: unknown): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new TypeError(`storage(${backend}): relPath must be a non-empty string`)
  }
  if (relPath.includes('\0') || relPath.includes('\\')) {
    throw new Error(`storage(${backend}): refusing path with NUL or backslash: ${JSON.stringify(relPath)}`)
  }
  // Callers may pass "finance/expense/1/r.pdf" or "/finance/..."; only
  // relative segments beneath the tenant root are ever accepted.
  const stripped = relPath.replace(/^\/+/, '')
  if (/^[a-zA-Z]:/.test(stripped)) {
    throw new Error(`storage(${backend}): refusing absolute path: ${JSON.stringify(relPath)}`)
  }
  const norm = posix.normalize(stripped)
  if (norm === '.' || norm === '..' || norm.startsWith('../') || norm.endsWith('/')) {
    throw new Error(`storage(${backend}): path escapes tenant root: ${JSON.stringify(relPath)}`)
  }
  if (PARTIAL_NAME_RE.test(posix.basename(norm))) {
    throw new Error(`storage(${backend}): reserved temp-file name: ${JSON.stringify(relPath)}`)
  }
  return `${tenantId}/${norm}`
}

/** spec-b S3: the composed key MUST start with `<tenantId>/`. Asserted inside
 *  every backend's put(), not only by callers. */
export function assertKeyInTenant(backend: string, tenantId: string, key: string): void {
  if (!key.startsWith(`${tenantId}/`) || key.length === tenantId.length + 1) {
    throw new Error(
      `storage(${backend}): composed key does not start with the tenant segment: ${JSON.stringify(key)}`,
    )
  }
}

/** A handle is accepted only when it is a canonical key under `<tenantId>/`.
 *  This is a check on the handle's own segments, not a string-prefix check on a
 *  resolved filesystem path: `<tenant>/a/../../<other>/x` is refused even
 *  though a path resolver would collapse it. */
export function assertHandleInTenant(backend: string, tenantId: string, handle: unknown): string {
  const refuse = (): never => {
    throw new Error(
      `storage(${backend}): handle escapes tenant root: ${
        typeof handle === 'string' ? JSON.stringify(handle) : typeof handle
      }`,
    )
  }
  if (typeof handle !== 'string') return refuse()
  if (handle.includes('\0') || handle.includes('\\')) return refuse()
  const prefix = `${tenantId}/`
  if (!handle.startsWith(prefix)) return refuse()
  const rest = handle.slice(prefix.length)
  if (rest.length === 0 || rest.startsWith('/') || rest.endsWith('/')) return refuse()
  if (posix.normalize(rest) !== rest) return refuse()
  if (rest === '..' || rest.startsWith('../') || rest.split('/').includes('..')) return refuse()
  return handle
}
