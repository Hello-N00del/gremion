import { describe, it, expect, vi, afterEach } from 'vitest'
import { assertSafeTestDbUrl } from '../integration/assert-safe-test-db-url'

// ── helpers ──────────────────────────────────────────────────────────────────

/** Call the guard and return the thrown error message, or null if it didn't throw. */
function guardError(url: string, varName = 'DATABASE_URL', env: Record<string, string> = {}): string | null {
  const saved = process.env.GREMION_ALLOW_DANGEROUS_DB_URL
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v
  }
  try {
    assertSafeTestDbUrl(url, varName)
    return null
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e)
  } finally {
    if (saved === undefined) {
      delete process.env.GREMION_ALLOW_DANGEROUS_DB_URL
    } else {
      process.env.GREMION_ALLOW_DANGEROUS_DB_URL = saved
    }
    // NOTE: env entries are deleted in finally rather than restored-to-prior.
    // Safe as long as `env` never overlaps a key already set in process.env
    // (GREMION_ALLOW_DANGEROUS_DB_URL has its own save/restore above).
    for (const k of Object.keys(env)) {
      delete process.env[k]
    }
  }
}

// ── documented fixture — always allowed ──────────────────────────────────────

describe('assertSafeTestDbUrl — documented fixture', () => {
  it('allows the exact documented DATABASE_URL fixture', () => {
    expect(guardError('postgres://gremion:gremion_test@localhost:5432/gremion')).toBeNull()
  })

  it('allows the exact documented CONTROL_DATABASE_URL fixture', () => {
    expect(guardError('postgres://gremion:gremion_test@localhost:5432/control', 'CONTROL_DATABASE_URL')).toBeNull()
  })

  it('treats postgresql:// scheme same as postgres://', () => {
    expect(guardError('postgresql://gremion:gremion_test@localhost:5432/gremion')).toBeNull()
  })
})

// ── localhost + test-name convention ─────────────────────────────────────────

describe('assertSafeTestDbUrl — localhost + test convention', () => {
  it('allows localhost:5432 with a test-prefixed database name', () => {
    expect(guardError('postgres://user:pass@localhost:5432/test_db')).toBeNull()
  })

  it('allows localhost:5432 with test in db name (not prefix)', () => {
    expect(guardError('postgres://user:pass@localhost:5432/gremion_test')).toBeNull()
  })

  it('allows localhost with a test-named username', () => {
    expect(guardError('postgres://test_user:pass@localhost:5432/mydb')).toBeNull()
  })

  it('allows 127.0.0.1 with test in database name', () => {
    expect(guardError('postgres://user:pass@127.0.0.1:5432/test_db')).toBeNull()
  })

  it('allows 127.0.0.1 with test in username', () => {
    expect(guardError('postgres://test_user:pw@127.0.0.1:5432/mydb')).toBeNull()
  })

  it('allows ::1 (IPv6 localhost) with test in database name', () => {
    expect(guardError('postgres://user:pass@[::1]:5432/test_db')).toBeNull()
  })

  it('allows ::1 with test in username', () => {
    expect(guardError('postgres://test_user:pw@[::1]:5432/mydb')).toBeNull()
  })

  it('allows localhost without explicit port with test name', () => {
    expect(guardError('postgres://user:pw@localhost/test_db')).toBeNull()
  })
})

// ── staging-shaped URL — must be REJECTED ─────────────────────────────────────

describe('assertSafeTestDbUrl — staging-shaped URL REJECTED', () => {
  it('rejects staging URL: localhost:5433 with user/db both "stura" (no test convention)', () => {
    const err = guardError('postgres://stura:some_password@localhost:5433/stura')
    expect(err).not.toBeNull()
    expect(err).toContain('DATABASE_URL')
    expect(err).toContain('GREMION_ALLOW_DANGEROUS_DB_URL')
  })

  it('rejects localhost with no test convention on db or username', () => {
    const err = guardError('postgres://myuser:pw@localhost:5432/mydb')
    expect(err).not.toBeNull()
  })

  it('rejects 127.0.0.1 with no test convention on db or username', () => {
    const err = guardError('postgres://stura:pw@127.0.0.1:5433/stura')
    expect(err).not.toBeNull()
  })
})

// ── password containing 'test' does NOT qualify ───────────────────────────────

describe('assertSafeTestDbUrl — password with "test" does NOT qualify', () => {
  it('rejects when only the password contains "test" but db/user do not', () => {
    const err = guardError('postgres://stura:gremion_test@localhost:5433/stura')
    expect(err).not.toBeNull()
  })

  it('rejects when only the password contains "test" on remote host', () => {
    const err = guardError('postgres://user:testpassword@db.example.com:5432/mydb')
    expect(err).not.toBeNull()
  })
})

// ── remote host — REJECTED even with test-convention name ────────────────────

describe('assertSafeTestDbUrl — remote host REJECTED', () => {
  it('rejects a remote host even when db name contains "test"', () => {
    const err = guardError('postgres://user:pw@db.example.com:5432/test_db')
    expect(err).not.toBeNull()
    expect(err).toContain('DATABASE_URL')
  })

  it('rejects a remote host even when username contains "test"', () => {
    const err = guardError('postgres://test_user:pw@db.example.com:5432/mydb')
    expect(err).not.toBeNull()
  })

  it('rejects docker-internal host even with test db name', () => {
    const err = guardError('postgres://stura:pw@postgres:5432/test_db')
    expect(err).not.toBeNull()
  })

  it('rejects "keycloak" docker network host', () => {
    const err = guardError('postgres://user:pw@keycloak:5432/test_db')
    expect(err).not.toBeNull()
  })
})

// ── escape hatch ──────────────────────────────────────────────────────────────

describe('assertSafeTestDbUrl — GREMION_ALLOW_DANGEROUS_DB_URL escape hatch', () => {
  afterEach(() => {
    delete process.env.GREMION_ALLOW_DANGEROUS_DB_URL
  })

  it('allows any URL when GREMION_ALLOW_DANGEROUS_DB_URL is set (truthy)', () => {
    process.env.GREMION_ALLOW_DANGEROUS_DB_URL = '1'
    const err = guardError('postgres://stura:pw@localhost:5433/stura')
    expect(err).toBeNull()
  })

  it('warns to stderr when GREMION_ALLOW_DANGEROUS_DB_URL is set', () => {
    process.env.GREMION_ALLOW_DANGEROUS_DB_URL = '1'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      assertSafeTestDbUrl('postgres://stura:pw@localhost:5433/stura', 'DATABASE_URL')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GREMION_ALLOW_DANGEROUS_DB_URL'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('does NOT throw for the escape hatch with a completely remote dangerous URL', () => {
    process.env.GREMION_ALLOW_DANGEROUS_DB_URL = '1'
    const err = guardError('postgres://prod:secret@prod.example.com:5432/production')
    expect(err).toBeNull()
  })

  it('does NOT bypass guard when GREMION_ALLOW_DANGEROUS_DB_URL is "false"', () => {
    process.env.GREMION_ALLOW_DANGEROUS_DB_URL = 'false'
    const err = guardError('postgres://stura:pw@localhost:5433/stura')
    expect(err).not.toBeNull()
  })

  it('does NOT bypass guard when GREMION_ALLOW_DANGEROUS_DB_URL is "0"', () => {
    process.env.GREMION_ALLOW_DANGEROUS_DB_URL = '0'
    const err = guardError('postgres://stura:pw@localhost:5433/stura')
    expect(err).not.toBeNull()
  })
})

// ── malformed / unparseable URL — fail closed ────────────────────────────────

describe('assertSafeTestDbUrl — malformed URL (fail-closed)', () => {
  it('rejects an empty string', () => {
    const err = guardError('')
    expect(err).not.toBeNull()
  })

  it('rejects a non-URL string', () => {
    const err = guardError('not-a-url')
    expect(err).not.toBeNull()
  })

  it('rejects a URL with no hostname', () => {
    const err = guardError('postgres:///mydb')
    expect(err).not.toBeNull()
  })

  it('rejects a URL with wrong scheme (mysql://)', () => {
    // Not a postgres URL — fail-closed
    const err = guardError('mysql://user:pw@localhost:3306/testdb')
    expect(err).not.toBeNull()
  })

  it('includes varName in error message for a malformed URL', () => {
    const err = guardError('not-a-url', 'CONTROL_DATABASE_URL')
    expect(err).not.toBeNull()
    expect(err).toContain('CONTROL_DATABASE_URL')
  })
})

// ── varName reflected in error message ───────────────────────────────────────

describe('assertSafeTestDbUrl — varName in error message', () => {
  it('includes the varName in the thrown error for DATABASE_URL', () => {
    const err = guardError('postgres://stura:pw@localhost:5433/stura', 'DATABASE_URL')
    expect(err).toContain('DATABASE_URL')
  })

  it('includes the varName in the thrown error for CONTROL_DATABASE_URL', () => {
    const err = guardError('postgres://stura:pw@localhost:5433/stura', 'CONTROL_DATABASE_URL')
    expect(err).toContain('CONTROL_DATABASE_URL')
  })
})
