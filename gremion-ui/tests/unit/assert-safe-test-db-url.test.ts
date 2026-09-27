// @vitest-environment node
//
// The truncating-harness guard (spec B section 6 "no-truncate suite", AM-B-05;
// TASK-028 / B15 task 11). Every harness that truncates or drops refuses to
// start unless its database URL names a host whose stack differs from the
// production stack of this host, as GREMION_PRODUCTION_STACK declares it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import * as guardModule from '../integration/assert-safe-test-db-url'
import { assertNonProductionDbUrl } from '../integration/assert-safe-test-db-url'

const UI_ROOT = path.resolve(__dirname, '..', '..')
const GUARD_SRC = path.join(UI_ROOT, 'tests', 'integration', 'assert-safe-test-db-url.ts')
const KEY = 'GREMION_PRODUCTION_STACK'
// An obvious fake credential: it must never appear in a refusal.
const FAKE_PW = 'fake-pw-0000'

let saved: string | undefined
beforeEach(() => {
  saved = process.env[KEY]
  delete process.env[KEY]
})
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

/** The refusal message, or null when the guard accepts. */
function refusal(url: string, prod: string | undefined, varName = 'DATABASE_URL'): string | null {
  if (prod === undefined) delete process.env[KEY]
  else process.env[KEY] = prod
  try {
    assertNonProductionDbUrl(url, varName)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

describe('assertNonProductionDbUrl', () => {
  it('1. is the ONLY export of the module (the old name and its hatch are gone)', () => {
    expect(Object.keys(guardModule).sort()).toEqual(['assertNonProductionDbUrl'])
  })

  it('2. refuses while GREMION_PRODUCTION_STACK is unset, empty or blank, and names the fix', () => {
    for (const prod of [undefined, '', '   ']) {
      const msg = refusal('postgres://gremion:gremion_test@localhost:5432/gremion', prod)
      expect(msg, `prod=${JSON.stringify(prod)}`).toMatch(/GREMION_PRODUCTION_STACK/)
      expect(msg).toMatch(/none/)
    }
  })

  it('3. refuses a GREMION_PRODUCTION_STACK that is not a stack name or `none`', () => {
    for (const prod of ['Gremion', 'gremion!', 'none,gremion', '-x', 'a'.repeat(33)]) {
      expect(refusal('postgres://u:p@postgres-staging:5432/db', prod), prod).toMatch(/GREMION_PRODUCTION_STACK/)
    }
  })

  it('4. refuses postgres-<prod>: the production database of this host', () => {
    const msg = refusal('postgres://g:p@postgres-gremion:5432/gremion', 'gremion')
    expect(msg).toMatch(/production/i)
    expect(msg).toContain('postgres-gremion')
    expect(refusal('postgresql://g:p@POSTGRES-GREMION:5432/x', 'gremion')).toMatch(/production/i)
  })

  it('5. refuses a loopback host while this host HAS a production stack', () => {
    for (const host of ['localhost', '127.0.0.1', '127.9.9.9', '[::1]']) {
      const msg = refusal(`postgres://gremion:gremion_test@${host}:5432/gremion_test`, 'gremion')
      expect(msg, host).toMatch(/loopback/i)
    }
  })

  it('6. accepts loopback only when GREMION_PRODUCTION_STACK=none, and only a test database there', () => {
    expect(refusal('postgres://gremion:gremion_test@localhost:5432/gremion', 'none')).toBeNull()
    expect(refusal('postgres://gremion:gremion_test@localhost:5432/control', 'none', 'CONTROL_DATABASE_URL')).toBeNull()
    expect(refusal('postgresql://gremion_test:x@127.0.0.1:55432/portal_case_1', 'none')).toBeNull()
    expect(refusal('postgres://u:p@[::1]:5432/test_db', 'none')).toBeNull()
    // the staging shape on a dev box: loopback, but not a test database
    expect(refusal('postgres://stura:stura@localhost:5433/stura', 'none')).toMatch(/test/)
  })

  it('7. refuses any host that is not stack-qualified (postgres-<stack>)', () => {
    for (const host of ['postgres', 'pgbouncer', 'db.example.org', '10.1.2.3', 'postgres-', 'postgres-Gremion_x', 'mypostgres-staging']) {
      const msg = refusal(`postgres://u:p@${host}:5432/db`, 'gremion')
      expect(msg, host).toMatch(/stack-qualified/)
    }
    expect(refusal('postgres://u:p@postgres:5432/db', 'none')).toMatch(/stack-qualified/)
  })

  it('8. accepts a stack-qualified host of ANOTHER stack', () => {
    expect(refusal('postgres://u:p@postgres-staging:5432/db', 'gremion')).toBeNull()
    expect(refusal('postgres://u:p@postgres-gremion-canary:5432/db', 'gremion')).toBeNull()
    expect(refusal('postgres://u:p@postgres-staging:5432/db', 'none')).toBeNull()
  })

  it('9. fails closed on a malformed URL, a wrong scheme or no host -- and never prints the password', () => {
    for (const url of ['', 'not a url', `mysql://u:${FAKE_PW}@postgres-staging/db`, `postgres://u:${FAKE_PW}@/db`, `postgres//u:${FAKE_PW}@x`]) {
      const msg = refusal(url, 'gremion')
      expect(msg, url).not.toBeNull()
      expect(msg).not.toContain(FAKE_PW)
    }
    expect(refusal(`postgres://g:${FAKE_PW}@postgres-gremion:5432/gremion`, 'gremion')).not.toContain(FAKE_PW)
    expect(refusal(`postgres://g:${FAKE_PW}@db.example.org:5432/x`, 'gremion')).not.toContain(FAKE_PW)
  })

  it('9b. refuses an authority postgres.js would read as several hosts (review finding HIGH)', () => {
    // postgres.js v3 splits the raw text between the first @ and the first / or ?
    // on commas and tries each host; WHATWG URL sees only one. Each of these
    // was ACCEPTED while the client could reach postgres-gremion.
    for (const url of [
      'postgres://u:p@postgres-staging#,postgres-gremion',
      'postgres://u:p@postgres-gremion,x@postgres-staging/db',
      'postgres://u:p@postgres-gremion:5432,a@postgres-staging:5432/db',
      'postgres://u:p@postgres-staging,postgres-other/db',
      'postgres://u:p@postgres-staging/db#frag',
    ]) {
      expect(refusal(url, 'gremion'), url).toMatch(/one host/)
    }
  })

  it('10. reads no environment variable but GREMION_PRODUCTION_STACK (no escape hatch)', () => {
    const src = readFileSync(GUARD_SRC, 'utf8')
    const reads = [...src.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([^'"]+)['"]\s*\])/g)].map(
      (m) => m[1] ?? m[2],
    )
    expect(new Set(reads)).toEqual(new Set([KEY]))
    expect(src).not.toMatch(/process\.env\[(?!\s*['"])/) // no computed key
    expect(src).not.toMatch(/\bconsole\.(warn|log)\b/) // nothing to warn about: no bypass exists
  })
})

describe('the harnesses call it and give it no default (D2)', () => {
  const HARNESS_FILES = [
    'vitest.integration.config.ts',
    'vitest.deselection.config.ts',
    'tests/integration/setup.ts',
    'tests/integration/deselection-setup.ts',
  ]

  it('no harness file assigns GREMION_PRODUCTION_STACK a value', () => {
    for (const f of HARNESS_FILES) {
      const src = readFileSync(path.join(UI_ROOT, f), 'utf8')
      expect(src, f).not.toMatch(/GREMION_PRODUCTION_STACK['"\]]?\s*(\?\?|\|\||&&)?=(?!=)/)
    }
  })

  it('setup.ts, deselection-setup.ts and the integration config each guard every URL they use', () => {
    const expected: Record<string, string[]> = {
      'vitest.integration.config.ts': ['DATABASE_URL', 'CONTROL_DATABASE_URL'],
      'tests/integration/setup.ts': ['DATABASE_URL', 'CONTROL_DATABASE_URL'],
      'tests/integration/deselection-setup.ts': ['DATABASE_URL'],
    }
    for (const [f, vars] of Object.entries(expected)) {
      const src = readFileSync(path.join(UI_ROOT, f), 'utf8')
      for (const v of vars) {
        expect(src, `${f} guards ${v}`).toContain(`assertNonProductionDbUrl(process.env.${v} ?? '', '${v}')`)
      }
    }
  })

  it('no integration test file reads the guard module under its old name', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|mjs|js)$/.test(e.name) && readFileSync(p, 'utf8').includes('assertSafe' + 'TestDbUrl')) {
          offenders.push(path.relative(UI_ROOT, p))
        }
      }
    }
    walk(path.join(UI_ROOT, 'src'))
    walk(path.join(UI_ROOT, 'tests'))
    expect(offenders).toEqual([])
  })

  // train4 (TASK-028 x TASK-062): an integration test that CREATEs or DROPs a
  // database is a dropping harness of its own. Like the portal-grant proof, it
  // runs the guard itself at import -- before any connection, not relying on
  // setupFiles -- so it refuses even when run under another config.
  it('every integration test that creates or drops a database guards DATABASE_URL itself at import', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.integration.test.ts')) {
          const src = readFileSync(p, 'utf8')
          if (!/\b(CREATE|DROP)\s+DATABASE\b/.test(src)) continue
          const imports = /import\s*\{[^}]*\bassertNonProductionDbUrl\b[^}]*\}\s*from\s*'[^']*tests\/integration\/assert-safe-test-db-url'/.test(src)
          const guardsAtImport = /^assertNonProductionDbUrl\(process\.env\.DATABASE_URL \?\? '', 'DATABASE_URL'\)$/m.test(src)
          if (!imports || !guardsAtImport) offenders.push(path.relative(UI_ROOT, p).split(path.sep).join('/'))
        }
      }
    }
    walk(path.join(UI_ROOT, 'src'))
    expect(offenders).toEqual([])
  })

  it('the integration config refuses to LOAD while GREMION_PRODUCTION_STACK is unset', () => {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env[KEY]
    delete env.DATABASE_URL
    delete env.CONTROL_DATABASE_URL
    const res = spawnSync(
      process.execPath,
      [
        path.join(UI_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        'vitest.integration.config.ts',
        '--passWithNoTests',
        'src/no-such-file-task028',
      ],
      { cwd: UI_ROOT, env, encoding: 'utf8', timeout: 120_000 },
    )
    const out = `${res.stdout}${res.stderr}`
    expect(res.status, out).not.toBe(0)
    expect(out).toContain(KEY)
  }, 150_000)
})
