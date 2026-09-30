/**
 * Fail-closed Postgres guard for the board leaf's DESTRUCTIVE integration suites.
 *
 * These suites CREATE/DROP/TRUNCATE databases. On the staging host, localhost:5432
 * is the LIVE kernel Postgres — so this guard (a) REQUIRES an explicit
 * BOARD_TEST_PG_URL (no localhost:5432 default) and (b) REJECTS port 5432 (and
 * the implicit default port) outright, BEFORE any connection is attempted. Mirrors
 * the finance leaf fix (PR #393) swept to the sibling leaves (#394).
 *
 * Side-effect-free: both functions throw only when CALLED, never at import — so the
 * PG-free unit suite can import them for negative-proof tests without needing PG.
 */
import { tenantModuleDbName } from '@gremion/tenant-store'
import { FIXTURE_TENANTS } from './tenants.ts'

const ENV_VAR = 'BOARD_TEST_PG_URL'
const LABEL = 'board-test-guard'

/**
 * The only (tenant, board) databases a destructive suite may create, migrate,
 * address or drop: t_<hex32>__board of the three fixed fixture tenants
 * (R29-BOARD-STORE-K item 3). Anything else — another tenant's database, another
 * module's, a kernel, platform or legacy name — is refused before any statement.
 */
export const SCRATCH_TENANT_DBS: ReadonlySet<string> = new Set(FIXTURE_TENANTS.map((t) => tenantModuleDbName(t.id, 'board')))

export function assertScratchTenantDb(name: string): void {
  if (typeof name !== 'string' || !SCRATCH_TENANT_DBS.has(name)) {
    throw new Error(
      `[${LABEL}] SAFETY VIOLATION: ${JSON.stringify(name)} is not one of the fixture tenant databases ` +
        `(${[...SCRATCH_TENANT_DBS].join(', ')}) — refusing.`,
    )
  }
}

/**
 * Return the required, explicitly-configured throwaway Postgres URL.
 * Throws (fail-closed) if BOARD_TEST_PG_URL is unset/empty — we refuse to
 * default to localhost:5432 (the LIVE staging Postgres on this host).
 */
export function requireEphemeralTestPgUrl(): string {
  const url = process.env[ENV_VAR]
  if (!url) {
    throw new Error(
      `[${LABEL}] ${ENV_VAR} is REQUIRED for the board integration suite — refusing to ` +
        'default to localhost:5432 (the LIVE staging Postgres on this host, which this suite ' +
        'would CREATE/DROP/TRUNCATE against). Start an ephemeral throwaway container on a ' +
        'NON-5432 port and export the URL, e.g.:\n' +
        '  docker run --rm -d --name board-test-pg -p 127.0.0.1:55434:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18-alpine\n' +
        `  export ${ENV_VAR}=postgres://postgres@localhost:55434/postgres`,
    )
  }
  return url
}

/**
 * Assert the resolved test PG URL is safe for a destructive suite:
 * postgres:// scheme, localhost host only, a NON-5432 port, and a `_test_` DB
 * namespace. Throws before any connection is attempted on any violation.
 */
export function assertSafeTestEnv(url: string, dbPrefix: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`[${LABEL}] ${ENV_VAR} is malformed: ${JSON.stringify(url)} — refusing to run.`)
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`[${LABEL}] must use postgres:// scheme. Got: ${parsed.protocol}`)
  }
  const rawHost = parsed.hostname.toLowerCase()
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(host)) {
    throw new Error(`[${LABEL}] SAFETY VIOLATION: non-localhost host "${host}" — refusing.`)
  }
  // Port 5432 (and the implicit default, i.e. an empty port) is the LIVE staging
  // Postgres on this host — reject it outright so a misconfiguration can never hit
  // live data, before any connection is attempted.
  if (parsed.port === '' || parsed.port === '5432') {
    throw new Error(
      `[${LABEL}] SAFETY VIOLATION: port "${parsed.port || '(implicit default 5432)'}" is the live ` +
        'Postgres — refusing. Use a throwaway container on a non-5432 port (e.g. 55434).',
    )
  }
  if (!dbPrefix.endsWith('_test_')) {
    throw new Error(
      `[${LABEL}] SAFETY VIOLATION: dbPrefix "${dbPrefix}" must end with "_test_" — refusing.`,
    )
  }
}
