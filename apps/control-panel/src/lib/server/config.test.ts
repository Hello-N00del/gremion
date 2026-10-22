// The panel's environment contract (README.md, section 11 (c)): a customer
// realm is never its issuer, loa2 is the only acr, secrets come from files,
// and "Neuer Mandant" says why it is disabled.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HEARTBEAT_STALE_SECONDS, loadConfig, newCustomerDisabledReason, type Env } from './config'

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

  it('PANEL_PROMETHEUS_URL is optional; plain http only to the loopback or a compose service name', () => {
    const none = loadConfig(GOOD)
    expect(none.ok && none.config.prometheusUrl).toBeNull()
    const svc = loadConfig({ ...GOOD, PANEL_PROMETHEUS_URL: 'http://prometheus:9090/' })
    expect(svc.ok && svc.config.prometheusUrl).toBe('http://prometheus:9090')
    expect(problemsOf(loadConfig({ ...GOOD, PANEL_PROMETHEUS_URL: 'http://metrics.example.org:9090' })).join('\n')).toMatch(/PANEL_PROMETHEUS_URL over plain http/)
    expect(problemsOf(loadConfig({ ...GOOD, PANEL_PROMETHEUS_URL: 'not a url' })).join('\n')).toMatch(/PANEL_PROMETHEUS_URL is not a URL/)
    // review r1: a value the WHATWG parser rejects is a reported problem, never a thrown 500
    expect(problemsOf(loadConfig({ ...GOOD, PANEL_PROMETHEUS_URL: 'http://a b' })).join('\n')).toMatch(/PANEL_PROMETHEUS_URL is not a URL/)
    expect(problemsOf(loadConfig({ ...GOOD, PANEL_PROMETHEUS_URL: 'https://u:p@prom.example' })).join('\n')).toMatch(/must not carry credentials/)
    expect(problemsOf(loadConfig({ ...GOOD, PANEL_PROMETHEUS_URL: 'http://[fd00::5]:9090' })).join('\n')).toMatch(/over plain http/)
    const v6 = loadConfig({ ...GOOD, PANEL_PROMETHEUS_URL: 'http://[::1]:9090' })
    expect(v6.ok && v6.config.prometheusUrl).toBe('http://[::1]:9090')
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
    expect(loadConfig({ ...GOOD, PLATFORM_DATABASE_URL: 'postgres://p:u@postgres:5432/gremion_platform', PANEL_EXECUTOR: 'queue' })).not.toBe(a)
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

describe('PANEL_EXECUTOR (TASK-043d D9): queue | none; gremion-tenant is decommissioned', () => {
  const DB = { PLATFORM_DATABASE_URL: 'postgres://p:u@postgres:5432/gremion_platform' }
  it('gremion-tenant is REFUSED with the decommission reason (R31-I4)', () => {
    const r = loadConfig({ ...GOOD, ...DB, PANEL_EXECUTOR: 'gremion-tenant' })
    expect(r.ok).toBe(false)
    expect(problemsOf(r).join(' ')).toMatch(/decommissioned \(R31-I4\).*queue/)
  })
  it('queue without PLATFORM_DATABASE_URL is a problem naming it', () => {
    const r = loadConfig({ ...GOOD, PANEL_EXECUTOR: 'queue' })
    expect(r.ok).toBe(false)
    expect(problemsOf(r).join(' ')).toMatch(/PANEL_EXECUTOR=queue requires PLATFORM_DATABASE_URL/)
  })
  it('queue with the platform database parses; anything else is refused', () => {
    const r = loadConfig({ ...GOOD, ...DB, PANEL_EXECUTOR: 'queue' })
    expect(r.ok && r.config.executor).toBe('queue')
    expect(loadConfig({ ...GOOD, PANEL_EXECUTOR: 'sh' }).ok).toBe(false)
  })
})

describe('newCustomerDisabledReason (Q6 / A9: visibly disabled, never hidden)', () => {
  const DB = 'postgres://p:u@postgres:5432/gremion_platform'
  const cfg = (extra: Record<string, string>) => {
    const r = loadConfig({ ...GOOD, ...extra })
    if (!r.ok) throw new Error('fixture: ' + r.problems.join('; '))
    return r.config
  }
  it('no platform database: disabled with the reason', () => {
    expect(newCustomerDisabledReason(cfg({}), 5)).toMatch(/PLATFORM_DATABASE_URL/)
  })
  it('PANEL_EXECUTOR=none: disabled with the reason', () => {
    expect(newCustomerDisabledReason(cfg({ PLATFORM_DATABASE_URL: DB }), 5)).toMatch(/PANEL_EXECUTOR=none/)
  })
  it('queue, platform database, a fresh heartbeat: enabled', () => {
    const c = cfg({ PLATFORM_DATABASE_URL: DB, PANEL_EXECUTOR: 'queue' })
    expect(newCustomerDisabledReason(c, 0)).toBeNull()
    expect(newCustomerDisabledReason(c, HEARTBEAT_STALE_SECONDS)).toBeNull()
  })
  it('queue but the executor heartbeat is older than 60 s, or there is none: disabled, naming it', () => {
    const c = cfg({ PLATFORM_DATABASE_URL: DB, PANEL_EXECUTOR: 'queue' })
    expect(HEARTBEAT_STALE_SECONDS).toBe(60)
    expect(newCustomerDisabledReason(c, 61)).toMatch(/Ausf.hrer nicht aktiv seit 61 s/)
    expect(newCustomerDisabledReason(c, null)).toMatch(/Ausf.hrer nicht aktiv/)
  })
})
