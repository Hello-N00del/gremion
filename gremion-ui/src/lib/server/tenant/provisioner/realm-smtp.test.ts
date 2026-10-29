// gremion#6 (spec B §T.4) — the smtpServer block the provisioner substitutes.
// The template bytes are read as shipped: these are the same bytes
// gremion-mail-bringup assert 6b greps in the release tree.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const KC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'docker', 'keycloak')
const RAW = readFileSync(join(KC, 'realm-export.base.json'), 'utf-8')
const TEMPLATE = JSON.parse(RAW) as Record<string, unknown>

describe('realm-export.base.json — the gremion#6 smtpServer block', () => {
  it('carries a top-level smtpServer object', () => {
    expect(TEMPLATE.smtpServer).toBeTypeOf('object')
  })

  it('carries exactly the seven __SMTP_*__ sentinels, every value a string (KC stores smtpServer as strings)', () => {
    const smtp = TEMPLATE.smtpServer as Record<string, string>
    expect(smtp).toEqual({
      host: '__SMTP_HOST__',
      port: '__SMTP_PORT__',
      from: '__SMTP_FROM__',
      fromDisplayName: 'Gremion',
      auth: 'true',
      user: '__SMTP_USER__',
      password: '__SMTP_PASSWORD__',
      starttls: '__SMTP_STARTTLS__',
      ssl: '__SMTP_SSL__',
    })
  })

  it('pairs with the email paths that make it mandatory (realm-export.base.json:7,9)', () => {
    expect(TEMPLATE.loginWithEmailAllowed).toBe(true)
    expect(TEMPLATE.resetPasswordAllowed).toBe(true)
  })

  it('hard-codes no mail host, no port and no credential in the template', () => {
    const smtp = JSON.stringify(TEMPLATE.smtpServer)
    expect(smtp).not.toMatch(/mail\./)
    expect(smtp).not.toMatch(/\b(25|465|587)\b/)
    expect(smtp).not.toMatch(/@/)
  })
})

import { MODULE_MANIFESTS } from '$lib/modules/registry'
import {
  buildTenantRealmDoc,
  smtpServerBlock,
  assertNoTemplateSentinels,
  PROVISIONER_SECRET_CLIENTS,
  type RealmSmtpSettings,
} from './realm-doc'

const TEST_APEX = 'council.example'
// NOTE: unlike the older suites, the base is handed over RAW — resolving
// __APEX_DOMAIN__ is now buildTenantRealmDoc's job, not the caller's.
const cfgOff = { modules: {} } as never
const clientSecrets = Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, `secret-${c}`]))
const smtp: RealmSmtpSettings = {
  host: 'mail.example.org',
  port: 587,
  from: 'no-reply@example.org',
  user: 'platform@example.org',
  password: 'unit-test-platform-password',
}
const build = (over: Partial<Parameters<typeof buildTenantRealmDoc>[0]> = {}) =>
  buildTenantRealmDoc({
    base: JSON.parse(RAW), manifests: MODULE_MANIFESTS, config: cfgOff,
    slug: 't2', realmName: 'verein', tenantHost: `t2.${TEST_APEX}`,
    apexDomain: TEST_APEX, clientSecrets, smtp, ...over,
  } as never)

describe('smtpServerBlock — TLS is required on every transport (spec A §I, gremion#6)', () => {
  it('587 negotiates STARTTLS and never implicit TLS', () => {
    const b = smtpServerBlock(smtp)
    expect(b.starttls).toBe('true')
    expect(b.ssl).toBe('false')
    expect(b.auth).toBe('true')
    expect(b.port).toBe('587')
  })
  it('25 — any non-465 transport — also requires STARTTLS', () => {
    expect(smtpServerBlock({ ...smtp, port: 25 })).toMatchObject({ starttls: 'true', ssl: 'false' })
  })
  it('465 is the one implicit-TLS transport', () => {
    expect(smtpServerBlock({ ...smtp, port: 465 })).toMatchObject({ starttls: 'false', ssl: 'true' })
  })
})

describe('buildTenantRealmDoc — sentinel substitution (spec B §T.4)', () => {
  it('fills the smtpServer block exactly as smtpServerBlock does (one source of truth with the delta path)', () => {
    expect(build().smtpServer).toEqual(smtpServerBlock(smtp))
  })

  it('POST-CONDITION: the composed doc contains zero __…__ sequences', () => {
    expect(JSON.stringify(build())).not.toMatch(/__[A-Z][A-Z0-9_]*__/)
  })

  it('resolves __APEX_DOMAIN__ itself, so the host swap still lands the tenant host', () => {
    const ui = (build().clients as Array<Record<string, unknown>>)
      .find((c) => c.clientId === 'gremion-ui') as { redirectUris: string[] }
    expect(ui.redirectUris).toContain(`https://t2.${TEST_APEX}/auth/callback/keycloak`)
    expect(ui.redirectUris.join(' ')).not.toContain('__APEX_DOMAIN__')
  })

  it('never host-swaps the PLATFORM sender onto the tenant host', () => {
    expect((build().smtpServer as Record<string, string>).from).toBe('no-reply@example.org')
  })

  it('FAIL-CLOSED: refuses to compose when email login is on and SMTP is unset', () => {
    expect(() => build({ smtp: { ...smtp, host: '' } }))
      .toThrow(/loginWithEmailAllowed\/resetPasswordAllowed are on but the platform SMTP settings are unset/)
  })

  it('assertNoTemplateSentinels names every survivor', () => {
    expect(() => assertNoTemplateSentinels({ realm: 'verein', leftover: '__SMTP_HOST__' } as never))
      .toThrow(/unresolved template sentinel\(s\).*__SMTP_HOST__/)
  })
})
