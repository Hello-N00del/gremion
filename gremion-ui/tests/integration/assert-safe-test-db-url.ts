/**
 * The truncating-harness guard (spec B section 6 "no-truncate suite", AM-B-05;
 * TASK-028 / B15 task 11).
 *
 * The integration suites are DESTRUCTIVE -- beforeEach truncates with RESTART
 * IDENTITY CASCADE, and the portal-grant proof creates and drops databases.
 * Every harness that truncates or drops calls assertNonProductionDbUrl for each
 * URL it connects to, BEFORE it connects (tests/integration/setup.ts and
 * deselection-setup.ts at import, vitest.integration.config.ts at config load).
 * The guard fails CLOSED: whatever it cannot positively place on a
 * non-production stack, it refuses.
 *
 * The contract is GREMION_PRODUCTION_STACK: the ${STACK} of the production unit
 * on this host, or the literal `none` on a host that has none. It has NO
 * default anywhere (D2) -- an unset key is a refusal that names the fix.
 *
 * A URL is accepted only when its host is ONE of:
 *   - stack-qualified: `postgres-<stack>` (the B14 per-stack alias), with
 *     <stack> different from GREMION_PRODUCTION_STACK;
 *   - loopback (localhost, 127.0.0.0/8, ::1), and only while
 *     GREMION_PRODUCTION_STACK=none -- on a host WITH a production stack a
 *     published loopback port may well be production's. Even then the database
 *     must be a test database: the documented fixture URLs, or a database or
 *     user name containing "test" (the password is never consulted). That keeps
 *     a dev box's non-test database on a published port (the staging shape,
 *     localhost:5433 db=stura) out of reach.
 * Everything else -- `postgres` (on a production host that IS production),
 * `pgbouncer`, a DNS name, an IP -- is refused as not stack-qualified.
 *
 * There is no escape hatch, and no refusal ever prints the URL: only the
 * variable name and the host. A URL carries a password.
 */

const STACK_NAME = /^[a-z][a-z0-9-]{0,31}$/
const STACK_QUALIFIED_HOST = /^postgres-([a-z][a-z0-9-]{0,31})$/

/** The documented integration fixtures (docs/TESTING.md), accepted on loopback. */
const DOCUMENTED_FIXTURES = new Set([
  'postgres://gremion:gremion_test@localhost:5432/gremion',
  'postgresql://gremion:gremion_test@localhost:5432/gremion',
  'postgres://gremion:gremion_test@localhost:5432/control',
  'postgresql://gremion:gremion_test@localhost:5432/control',
])

const DESTRUCTIVE = 'The harness truncates and drops; refusing to start.'

function refuse(varName: string, reason: string): never {
  throw new Error(`[no-truncate-guard] ${varName}: ${reason}\n  ${DESTRUCTIVE}`)
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

/**
 * Throws unless `url` names a database that cannot be this host's production
 * database. Call it for every URL a truncating or dropping harness uses, before
 * the first connection.
 *
 * @param url     the database URL (DATABASE_URL, CONTROL_DATABASE_URL, ...)
 * @param varName the variable the URL came from, for the refusal message
 */
export function assertNonProductionDbUrl(url: string, varName: string): void {
  const prod = (process.env.GREMION_PRODUCTION_STACK ?? '').trim()
  if (prod === '') {
    refuse(
      varName,
      'GREMION_PRODUCTION_STACK is unset. Set it to the STACK of the production unit on this ' +
        'host, or to `none` when this host runs no production unit (spec B section 6). It has no default.',
    )
  }
  if (prod !== 'none' && !STACK_NAME.test(prod)) {
    refuse(varName, 'GREMION_PRODUCTION_STACK is neither `none` nor a stack name (^[a-z][a-z0-9-]{0,31}$).')
  }

  // The client does not parse the URL the way WHATWG URL does: postgres.js v3
  // takes the raw text between the first `@` and the first `/` or `?` as a
  // comma-separated host LIST and tries each in turn (a `#` does not end it).
  // A URL whose authority can be read as more than one host is therefore
  // refused outright -- the guard must judge the host the client dials.
  const schemeEnd = url.indexOf('://')
  const authority = schemeEnd < 0 ? '' : url.slice(schemeEnd + 3).split(/[/?]/)[0]
  let decoded = authority
  try {
    decoded = decodeURIComponent(authority)
  } catch {
    refuse(varName, 'has an undecodable authority.')
  }
  if (url.includes('#') || /[,\\\s]/.test(decoded) || (authority.match(/@/g) ?? []).length > 1) {
    refuse(varName, 'must name exactly one host: its authority contains `,`, `#`, whitespace, a backslash or a second `@`.')
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    refuse(varName, 'is empty or not a URL.')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    refuse(varName, 'is not a postgres:// or postgresql:// URL.')
  }
  // Node keeps the brackets of an IPv6 host for non-special schemes.
  const raw = parsed.hostname.toLowerCase()
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (host === '') refuse(varName, 'names no host.')

  const qualified = STACK_QUALIFIED_HOST.exec(host)
  if (qualified) {
    if (qualified[1] === prod) {
      refuse(
        varName,
        `host ${host} is the PRODUCTION database of this host (GREMION_PRODUCTION_STACK=${prod}). ` +
          'Point the harness at a scratch stack.',
      )
    }
    return
  }

  if (isLoopback(host)) {
    if (prod !== 'none') {
      refuse(
        varName,
        `host ${host} is loopback, and this host runs the production stack ${prod}: a loopback port ` +
          'cannot be told apart from production. Use a stack-qualified host (postgres-<stack>).',
      )
    }
    if (DOCUMENTED_FIXTURES.has(url)) return
    const db = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase()
    const user = decodeURIComponent(parsed.username).toLowerCase()
    if (!db.includes('test') && !user.includes('test')) {
      refuse(
        varName,
        `host ${host} is loopback, but neither the database nor the user name contains "test" ` +
          '(the staging shape on a dev box). Use the documented fixture or a test database.',
      )
    }
    return
  }

  refuse(
    varName,
    `host ${host} is not stack-qualified: expected postgres-<stack> with a stack other than ` +
      `${prod === 'none' ? 'the (absent) production stack' : prod}, or loopback on a host with GREMION_PRODUCTION_STACK=none.`,
  )
}
