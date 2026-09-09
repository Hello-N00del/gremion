/**
 * Fail-closed guard for integration-suite database URLs.
 *
 * The integration suite (pnpm test:integration) is DESTRUCTIVE — beforeEach
 * truncates tables with RESTART IDENTITY CASCADE. This machine is ALSO the
 * live staging host (Postgres published on localhost:5433 per
 * docker-compose.override.yml). If a shell DATABASE_URL or CONTROL_DATABASE_URL
 * points at staging, pnpm test:integration will wipe it.
 *
 * This guard is called at the top of tests/integration/setup.ts (runtime) and
 * at the top of vitest.integration.config.ts (vitest boot time) for every URL
 * the integration suite uses.
 *
 * Allowed URLs:
 *   1. The exact documented fixture URLs:
 *        postgres://gremion:gremion_test@localhost:5432/gremion      (DATABASE_URL)
 *        postgres://gremion:gremion_test@localhost:5432/control    (CONTROL_DATABASE_URL)
 *   2. URLs where host is localhost / 127.0.0.1 / ::1 AND (database name OR
 *      username) contains "test" (case-insensitive). The password is explicitly
 *      excluded from the convention check.
 *
 * Rejected URLs (throw Error):
 *   - Anything with a non-localhost host (remote DBs, Docker-internal names, etc.)
 *   - localhost/127.0.0.1/::1 with neither db-name nor username containing "test"
 *     (catches the staging shape: localhost:5433 user=stura db=stura)
 *   - Malformed / unparseable URLs (fail-closed)
 *   - Wrong scheme (only postgres:// / postgresql:// accepted)
 *
 * Escape hatch (use with extreme care):
 *   Set GREMION_ALLOW_DANGEROUS_DB_URL=1 to bypass the guard. A loud console.warn
 *   is emitted. Never use this in CI or on the staging host.
 */

/** Localhost variants recognised as safe hosts. */
const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** The exact documented fixture URLs that are always permitted. */
const DOCUMENTED_FIXTURES = new Set([
  'postgres://gremion:gremion_test@localhost:5432/gremion',
  'postgresql://gremion:gremion_test@localhost:5432/gremion',
  'postgres://gremion:gremion_test@localhost:5432/control',
  'postgresql://gremion:gremion_test@localhost:5432/control',
])

/**
 * Asserts that `url` is safe to use as a destructive integration-suite
 * database. Throws a clear, actionable Error when the URL is unsafe.
 *
 * @param url     The database URL to check (DATABASE_URL or CONTROL_DATABASE_URL value).
 * @param varName The env-var name for human-readable error messages.
 */
export function assertSafeTestDbUrl(url: string, varName: string): void {
  // ── escape hatch ────────────────────────────────────────────────────────────
  if (process.env.GREMION_ALLOW_DANGEROUS_DB_URL === '1') {
    console.warn(
      `[test-db-guard] WARNING: GREMION_ALLOW_DANGEROUS_DB_URL is set — ` +
        `the safety check for ${varName} has been bypassed. ` +
        `This must NEVER be used in CI or on the staging host.`,
    )
    return
  }

  // ── documented fixtures — always safe ───────────────────────────────────────
  if (DOCUMENTED_FIXTURES.has(url)) {
    return
  }

  // ── parse — fail-closed on any parse error ───────────────────────────────────
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `[test-db-guard] ${varName} is malformed or empty and cannot be parsed as a URL.\n` +
        `  Got: ${JSON.stringify(url)}\n` +
        `  The integration suite is DESTRUCTIVE — refusing to run with an unparseable URL.\n` +
        `  Fix ${varName} or set GREMION_ALLOW_DANGEROUS_DB_URL=1 to bypass (use with extreme care).`,
    )
  }

  // ── scheme check — only postgres(ql):// accepted ─────────────────────────────
  const scheme = parsed.protocol // includes trailing ':'
  if (scheme !== 'postgres:' && scheme !== 'postgresql:') {
    throw new Error(
      `[test-db-guard] ${varName} does not use a postgres:// or postgresql:// scheme.\n` +
        `  Got scheme: ${scheme}\n` +
        `  The integration suite only connects to PostgreSQL — refusing to run.\n` +
        `  Fix ${varName} or set GREMION_ALLOW_DANGEROUS_DB_URL=1 to bypass (use with extreme care).`,
    )
  }

  // ── extract host — strip IPv6 brackets ───────────────────────────────────────
  // For non-special URL schemes (postgres://, postgresql://), Node's URL parser
  // does NOT strip brackets from IPv6 addresses — URL.hostname returns "[::1]"
  // rather than "::1". Strip them explicitly so the LOCALHOST_HOSTS lookup works.
  const rawHostname = parsed.hostname.toLowerCase()
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname

  if (!hostname) {
    throw new Error(
      `[test-db-guard] ${varName} has no hostname — refusing to run the destructive integration suite.\n` +
        `  Fix ${varName} or set GREMION_ALLOW_DANGEROUS_DB_URL=1 to bypass (use with extreme care).`,
    )
  }

  // ── host must be localhost ────────────────────────────────────────────────────
  if (!LOCALHOST_HOSTS.has(hostname)) {
    throw new Error(
      `[test-db-guard] SAFETY VIOLATION: ${varName} points at a non-localhost host.\n` +
        `  Host: ${hostname}\n` +
        `  The integration suite is DESTRUCTIVE (TRUNCATE … CASCADE). Refusing to run\n` +
        `  against anything but localhost / 127.0.0.1 / ::1.\n` +
        `  Fix ${varName} to point at the local test fixture, or set\n` +
        `  GREMION_ALLOW_DANGEROUS_DB_URL=1 to bypass (use with extreme care — NEVER in CI).`,
    )
  }

  // ── localhost: require test convention on db-name OR username ────────────────
  // The password is explicitly excluded — it coincidentally contains "test" in
  // the documented fixture (gremion_test) and must not be used as a safety signal.
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase()
  const username = decodeURIComponent(parsed.username).toLowerCase()

  // Substring match is intentional: 'test_db', 'gremion_test', 'test' all pass.
  // Note: words like 'latest', 'attestation' also contain 'test'. If your staging
  // DB name happens to match, do NOT rely on this check — the threat model here is
  // db/user named 'stura'; canonical URLs belong in DOCUMENTED_FIXTURES above.
  const dbHasTestConvention = dbName.includes('test')
  const userHasTestConvention = username.includes('test')

  if (!dbHasTestConvention && !userHasTestConvention) {
    throw new Error(
      `[test-db-guard] SAFETY VIOLATION: ${varName} points at localhost but neither the\n` +
        `  database name ("${dbName}") nor the username ("${username}") contains "test".\n` +
        `  This matches the staging-DB shape (e.g. localhost:5433 user=stura db=stura) and\n` +
        `  the integration suite is DESTRUCTIVE (TRUNCATE … CASCADE).\n` +
        `  Either fix ${varName} to point at the documented test fixture:\n` +
        `    postgres://gremion:gremion_test@localhost:5432/gremion\n` +
        `  Or set GREMION_ALLOW_DANGEROUS_DB_URL=1 to bypass (use with extreme care — NEVER in CI).`,
    )
  }

  // ── passed all checks ────────────────────────────────────────────────────────
}
