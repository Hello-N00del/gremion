// packages/tenant-store/src/names.ts
//
// D13: one database per (tenant, module). This file is the only place that
// turns a (tenant id, module id) pair into a database name or a connection
// url, and everything it returns has been validated against an allow-list —
// the name is later interpolated into connection strings (and, by TASK-021,
// into CREATE DATABASE), so nothing here trusts its input.

/** RFC 9562 version-7 UUID, canonical lowercase form (TASK-019 Q2). */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * A module id: lowercase ASCII, starts with a letter, single underscores only.
 * No `__`, no trailing `_`: the separator in t_<hex>__<module> stays unambiguous.
 */
const MODULE_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

/** Postgres truncates identifiers to NAMEDATALEN - 1 = 63 bytes. */
const MAX_IDENTIFIER_BYTES = 63

export function isUuidV7(id: string): boolean {
  return UUID_V7.test(id)
}

export function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || !UUID_V7.test(tenantId)) {
    throw new TypeError(`tenant id is not a canonical lowercase UUIDv7: ${JSON.stringify(tenantId)}`)
  }
}

export function assertModuleId(moduleId: string): void {
  if (typeof moduleId !== 'string' || !MODULE_ID.test(moduleId)) {
    throw new TypeError(`module id must match ${MODULE_ID.source}: ${JSON.stringify(moduleId)}`)
  }
}

/**
 * The database that holds one module's data for one tenant:
 * t_<tenant uuid as 32 hex>__<module>. Throws unless the result is [a-z0-9_]
 * and at most 63 bytes (a longer name would be silently truncated by Postgres
 * and could collide with another module's).
 */
export function tenantModuleDbName(tenantId: string, moduleId: string): string {
  assertTenantId(tenantId)
  assertModuleId(moduleId)
  const name = `t_${tenantId.replaceAll('-', '')}__${moduleId}`
  if (!/^[a-z0-9_]+$/.test(name) || Buffer.byteLength(name, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new RangeError(`database name ${name} exceeds ${MAX_IDENTIFIER_BYTES} bytes or leaves [a-z0-9_]`)
  }
  return name
}

export interface TenantTarget {
  /** postgres:// url whose database is exactly tenantModuleDbName(tenant, module). */
  url: string
}

/** Q2: injected; the control-registry lookup arrives with TASK-077. */
export type ResolveTarget = (tenantId: string, moduleId: string) => TenantTarget | Promise<TenantTarget>

/**
 * postgres-js turns every url query parameter it does not know into a startup
 * parameter (database, role, search_path, options, ...), and a startup
 * parameter can move the connection to another database or identity. Only
 * these are allowed through, each with the values that are safe:
 * TLS on (no disable/allow/prefer: a resolver must not switch TLS off);
 * sslrootcert only as `system` (postgres-js maps it to verify-full; any
 * other value would be forwarded as an unknown startup parameter).
 */
const ALLOWED_QUERY_PARAMS: Readonly<Record<string, (v: string) => boolean>> = {
  sslmode: (v) => v === 'require' || v === 'verify-ca' || v === 'verify-full',
  sslrootcert: (v) => v === 'system',
  target_session_attrs: (v) => v === 'read-write' || v === 'primary',
  application_name: (v) => /^[A-Za-z0-9_.:-]{1,63}$/.test(v),
}

function parsePostgresUrl(url: string, what: string): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new TypeError(`${what}: cannot parse the url`)
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new TypeError(`${what}: scheme ${u.protocol} is not postgres:// or postgresql://`)
  }
  return u
}

/**
 * Throws unless `url` connects to exactly `dbName`: no other path, and no query
 * parameter that postgres-js would forward as a startup parameter. Applied to
 * every resolver's answer, the injected ones included, so a resolver bug
 * cannot hand tenant A's pool tenant B's database. Never echoes the url (it
 * carries credentials).
 */
export function assertTargetMatches(url: string, dbName: string): void {
  const u = parsePostgresUrl(url, 'tenant target')
  if (u.pathname !== `/${dbName}`) {
    throw new Error(`tenant target does not name database ${dbName}`)
  }
  // No host or user would let postgres-js fall back to PGHOST / PGUSER /
  // PGPASSWORD from the environment — possibly an admin identity.
  if (!u.hostname || !u.username) {
    throw new Error('tenant target must name its host and user explicitly (no PGHOST/PGUSER fallback)')
  }
  if (u.hash) throw new Error('tenant target carries a fragment, which is not allowed')
  for (const [key, value] of u.searchParams) {
    const ok = ALLOWED_QUERY_PARAMS[key]
    if (!ok) throw new Error(`tenant target carries the query parameter '${key}', which is not allowed`)
    if (!ok(value)) throw new Error(`tenant target's query parameter '${key}' has a value that is not allowed`)
  }
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * GREMION_<MODULE>_PG_URL: the module's server as runtime pools reach it (a
 * pooler is fine). GREMION_<MODULE>_PG_DIRECT_URL (`direct`): the server
 * itself, for the migration runner (Q3). The path is replaced either way.
 */
export function moduleUrlVariable(moduleId: string, kind: 'runtime' | 'direct' = 'runtime'): string {
  assertModuleId(moduleId)
  return `GREMION_${moduleId.toUpperCase()}_PG_${kind === 'direct' ? 'DIRECT_' : ''}URL`
}

/**
 * Q2 default resolver: the module server's url from GREMION_<MODULE>_PG_URL
 * (or, for `direct`, GREMION_<MODULE>_PG_DIRECT_URL — no fallback to the
 * runtime url, which may be a pooler), with its database replaced by
 * tenantModuleDbName(tenant, module).
 */
export function envResolveTarget(env: Env = process.env, kind: 'runtime' | 'direct' = 'runtime'): (tenantId: string, moduleId: string) => TenantTarget {
  return (tenantId, moduleId) => {
    const dbName = tenantModuleDbName(tenantId, moduleId)
    const variable = moduleUrlVariable(moduleId, kind)
    const base = env[variable]
    if (!base) throw new Error(`${variable} is not set`)
    const u = parsePostgresUrl(base, variable)
    u.pathname = `/${dbName}`
    const url = u.toString()
    assertTargetMatches(url, dbName)
    return { url }
  }
}
