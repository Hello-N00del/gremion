// P2.1c (T19, §7.10 half 2) — tenant-id-tagged structured logging seam unit
// tests. Pure: no DB, no network. Every per-tenant case uses runWithTenant(ctx)
// (NOT the integration-harness default) so a fail-closed regression in the
// tenant carrier cannot be masked.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tlog } from './tenant-log'
import { runWithTenant, type TenantContext } from '$lib/server/tenant/context'

// Minimal structural context — this test only needs ctx.id; the resolver/rebind
// tasks own full field construction (same pattern as context.test.ts).
function fakeCtx(id: string): TenantContext {
  return {
    id,
    slug: id,
    db: {} as TenantContext['db'],
    issuer: `https://${id}.example.org/auth/realms/${id}`,
    kcInternal: `http://keycloak:8080/auth/realms/${id}`,
    audiences: ['gremion-ui'],
    kcAdminClient: {} as TenantContext['kcAdminClient'],
    realmName: id,
    kcAdminUrl: 'http://keycloak:8080/auth',
    kcClientId: 'gremion-admin',
    kcClientSecretRef: `kc-${id}`,
    authExternalBase: `https://${id}.example.org/auth/realms/${id}`,
    authClientId: 'gremion-ui',
    authClientSecretRef: `ui-${id}`,
    brand: {} as TenantContext['brand'],
    config: {} as TenantContext['config'],
    aliasNamespace: `${id}-`,
    accent: null,
    logoUrl: null,
    configPath: `/data/${id}/config.json`,
    dbUrl: `postgres://${id}`,
    dbMax: 3,
    dbPrepare: true,
  }
}

/** Capture the single line tlog writes to the level-matching console method. */
function captureLine(level: 'info' | 'warn' | 'error', fn: () => void): Record<string, unknown> {
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
  const spy = vi.spyOn(console, method).mockImplementation(() => {})
  try {
    fn()
    expect(spy).toHaveBeenCalledTimes(1)
    const arg = spy.mock.calls[0]![0]
    expect(typeof arg).toBe('string')
    // Single-line invariant: exactly one record, no embedded newline.
    expect(arg as string).not.toContain('\n')
    return JSON.parse(arg as string) as Record<string, unknown>
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tlog — tenant tagging', () => {
  it('carries the active tenant id inside runWithTenant', () => {
    const rec = captureLine('info', () =>
      runWithTenant(fakeCtx('id-acme'), () => tlog('info', 'provisioned')),
    )
    expect(rec.tenant).toBe('id-acme')
    expect(rec.level).toBe('info')
    expect(rec.msg).toBe('provisioned')
  })

  it('tags tenant: null OUTSIDE any tenant context (fail-OPEN for cosmetic logging)', () => {
    const rec = captureLine('warn', () => tlog('warn', 'boot step'))
    expect(rec.tenant).toBeNull()
    expect(rec.level).toBe('warn')
    expect(rec.msg).toBe('boot step')
  })

  it('uses the distinct active id when two contexts log in sequence', () => {
    const a = captureLine('error', () =>
      runWithTenant(fakeCtx('id-a'), () => tlog('error', 'x')),
    )
    const b = captureLine('error', () =>
      runWithTenant(fakeCtx('id-b'), () => tlog('error', 'x')),
    )
    expect(a.tenant).toBe('id-a')
    expect(b.tenant).toBe('id-b')
  })
})

describe('tlog — field merge', () => {
  it('merges caller fields into the record alongside the structural keys', () => {
    const rec = captureLine('info', () =>
      runWithTenant(fakeCtx('id-t2'), () =>
        tlog('info', 'tick', { worker: 'newsletter', count: 3, ok: true, last: null }),
      ),
    )
    expect(rec).toMatchObject({
      level: 'info',
      msg: 'tick',
      tenant: 'id-t2',
      worker: 'newsletter',
      count: 3,
      ok: true,
      last: null,
    })
  })

  it('never lets caller fields shadow level/msg/tenant', () => {
    const rec = captureLine('warn', () =>
      runWithTenant(fakeCtx('id-real'), () =>
        // Structural keys passed as caller fields must NOT win — the seam strips
        // them so a record can never be tenant-spoofed via a field.
        tlog('warn', 'real', { level: 'info', msg: 'spoof', tenant: 'id-spoof' }),
      ),
    )
    expect(rec.level).toBe('warn')
    expect(rec.msg).toBe('real')
    expect(rec.tenant).toBe('id-real')
  })
})

describe('tlog — PII-safe by construction (denylist)', () => {
  // The seam drops these keys regardless of value. Each entry exercises one
  // denylist substring; mixed-case keys prove case-insensitivity.
  const deniedFields: Record<string, string> = {
    email: 'a@b.test',
    userEmail: 'a@b.test',
    token: 'tok_abc',
    access_token: 'tok_abc',
    refreshToken: 'tok_abc',
    secret: 's',
    client_secret: 's',
    password: 'p',
    passwd: 'p',
    Authorization: 'Bearer x',
    cookie: 'sid=1',
    apiKey: 'k',
    api_key: 'k',
  }

  it('drops every PII/credential-shaped field but keeps safe siblings', () => {
    const rec = captureLine('error', () =>
      runWithTenant(fakeCtx('id-pii'), () =>
        tlog('error', 'login failed', { ...deniedFields, attempt: 2, route: '/auth' }),
      ),
    )
    // Safe fields survive.
    expect(rec.attempt).toBe(2)
    expect(rec.route).toBe('/auth')
    expect(rec.tenant).toBe('id-pii')
    // No denied key is present in the serialised record.
    for (const key of Object.keys(deniedFields)) {
      expect(rec, `denied key "${key}" must not appear`).not.toHaveProperty(key)
    }
    // And no value of a denied field leaked under any key.
    const serialised = JSON.stringify(rec)
    expect(serialised).not.toContain('a@b.test')
    expect(serialised).not.toContain('tok_abc')
    expect(serialised).not.toContain('Bearer x')
  })
})
