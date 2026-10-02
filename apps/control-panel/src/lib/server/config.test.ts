// The panel's environment contract (README.md, section 11 (c)): a customer
// realm is never its issuer, loa2 is the only acr, secrets come from files,
// and "Neuer Mandant" says why it is disabled.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig, newCustomerDisabledReason, resolveOnPath, type Env } from './config'

const FIX = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const GOOD: Env = {
  ORIGIN: 'http://127.0.0.1:3043',
  PANEL_OIDC_ISSUER: 'https://platform.example/auth/realms/platform',
  PANEL_OIDC_INTERNAL_BASE: 'https://keycloak:8443/auth',
  PANEL_OIDC_CLIENT_ID: 'control-panel',
  PANEL_OIDC_CLIENT_SECRET_FILE: join(FIX, 'client_secret'),
  AUTH_SECRET_FILE: join(FIX, 'auth_secret'),
  PANEL_REQUIRED_ACR: 'loa2',
  CONTROL_DATABASE_URL: 'postgres://control:unit@postgres:5432/control',
}

/** The problems of a result, or [] when it parsed (keeps every expect unconditional). */
const problemsOf = (r: ReturnType<typeof loadConfig>): string[] => (r.ok ? [] : r.problems)

describe('loadConfig', () => {
  it('a complete contract parses; secrets come from the files', () => {
    const r = loadConfig(GOOD)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.realm).toBe('platform')
    expect(r.config.clientSecret).toBe('fixture-not-a-secret-client')
    expect(r.config.executor).toBe('none')
    expect(r.config.platformDatabaseUrl).toBeNull()
  })

  it('a customer realm as issuer is refused (TRD-048)', () => {
    const r = loadConfig({ ...GOOD, PANEL_OIDC_ISSUER: 'https://rat.musterstadt.example/auth/realms/musterstadt' })
    expect(r.ok).toBe(false)
    expect(problemsOf(r).join('\n')).toMatch(/ops realm platform/)
  })

  it('an acr other than loa2 is refused', () => {
    expect(loadConfig({ ...GOOD, PANEL_REQUIRED_ACR: 'loa1' }).ok).toBe(false)
    expect(loadConfig({ ...GOOD, PANEL_REQUIRED_ACR: undefined }).ok).toBe(false)
  })

  it.each(['ORIGIN', 'PANEL_OIDC_ISSUER', 'PANEL_OIDC_INTERNAL_BASE', 'PANEL_OIDC_CLIENT_ID', 'PANEL_OIDC_CLIENT_SECRET_FILE', 'AUTH_SECRET_FILE', 'CONTROL_DATABASE_URL'])(
    'without %s the config is invalid, and the problem names it without a value',
    (key) => {
      const r = loadConfig({ ...GOOD, [key]: undefined })
      expect(r.ok).toBe(false)
      expect(problemsOf(r).join('\n')).toContain(key)
      expect(problemsOf(r).join('\n')).not.toMatch(/fixture-not-a-secret/)
    },
  )

  it('is parsed once per environment (review A, r2): a second call returns the same config without re-reading the secret files', () => {
    const a = loadConfig({ ...GOOD })
    const b = loadConfig({ ...GOOD })
    expect(a.ok).toBe(true)
    expect(b).toBe(a)
    // a different environment is parsed afresh
    expect(loadConfig({ ...GOOD, PANEL_EXECUTOR: 'gremion-tenant' })).not.toBe(a)
  })

  it('PANEL_OIDC_INTERNAL_BASE must be https off the compose network: a dotted host over http is refused (review A, r2)', () => {
    expect(loadConfig({ ...GOOD, PANEL_OIDC_INTERNAL_BASE: 'http://keycloak.example.org:8080/auth' }).ok).toBe(false)
    expect(loadConfig({ ...GOOD, PANEL_OIDC_INTERNAL_BASE: 'http://t043-kc:8080/auth' }).ok).toBe(true)
    expect(loadConfig({ ...GOOD, PANEL_OIDC_INTERNAL_BASE: 'http://127.0.0.1:8080/auth' }).ok).toBe(true)
  })

  it('a secret file that cannot be read is a named problem, never a value', () => {
    const r = loadConfig({ ...GOOD, AUTH_SECRET_FILE: join(FIX, 'absent') })
    expect(r.ok).toBe(false)
    expect(problemsOf(r)).toContain('AUTH_SECRET_FILE names a file that cannot be read')
  })

  it('an http issuer off the loopback is refused, an origin with a path is refused', () => {
    expect(loadConfig({ ...GOOD, PANEL_OIDC_ISSUER: 'http://platform.example/auth/realms/platform' }).ok).toBe(false)
    expect(loadConfig({ ...GOOD, ORIGIN: 'http://127.0.0.1:3043/x' }).ok).toBe(false)
    expect(loadConfig({ ...GOOD, PANEL_EXECUTOR: 'sh' }).ok).toBe(false)
  })
})

describe('newCustomerDisabledReason (Q6: visibly disabled, never hidden)', () => {
  it('no platform database, no executor: disabled with the reason; both present: enabled', () => {
    const base = loadConfig(GOOD)
    if (!base.ok) throw new Error('fixture')
    expect(newCustomerDisabledReason(base.config)).toMatch(/PLATFORM_DATABASE_URL/)
    const withDb = loadConfig({ ...GOOD, PLATFORM_DATABASE_URL: 'postgres://p:u@postgres:5432/gremion_platform' })
    if (!withDb.ok) throw new Error('fixture')
    expect(newCustomerDisabledReason(withDb.config)).toMatch(/PANEL_EXECUTOR=none/)
    const both = loadConfig({ ...GOOD, PLATFORM_DATABASE_URL: 'postgres://p:u@postgres:5432/gremion_platform', PANEL_EXECUTOR: 'gremion-tenant' })
    if (!both.ok) throw new Error('fixture')
    expect(newCustomerDisabledReason(both.config, () => '/usr/local/bin/gremion-tenant')).toBeNull()
  })

  it('PANEL_EXECUTOR=gremion-tenant but no gremion-tenant on PATH (the runtime image ships none): disabled with that reason', () => {
    const both = loadConfig({ ...GOOD, PLATFORM_DATABASE_URL: 'postgres://p:u@postgres:5432/gremion_platform', PANEL_EXECUTOR: 'gremion-tenant' })
    if (!both.ok) throw new Error('fixture')
    expect(newCustomerDisabledReason(both.config, () => null)).toMatch(/gremion-tenant.*PATH/)
  })

  it('resolveOnPath finds an executable file on PATH and nothing else', () => {
    expect(resolveOnPath('t043-no-such-gremion-tenant', FIX)).toBeNull()
    // a directory entry and a non-executable file are not an executor
    expect(resolveOnPath('__fixtures__', dirname(FIX))).toBeNull()
    expect(resolveOnPath('client_secret', FIX)).toBeNull()
  })
})
