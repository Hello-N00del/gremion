// Security sweep 2 (findings 3 and 6): the realm template and the realm a
// tenant is provisioned with must
//  - not let a user WITHOUT a second factor enroll one inside the step-up and
//    leave with acr=loa2 (the OTP form is an ALTERNATIVE under a REQUIRED
//    subflow, next to a deny-access ALTERNATIVE; never a REQUIRED OTP form,
//    which makes Keycloak run CONFIGURE_TOTP and then grant loa2);
//  - carry a password policy and make the confidential gremion-ui client use
//    PKCE S256;
//  - NOT enable refresh-token rotation (revokeRefreshToken / refreshTokenMaxReuse
//    stay at the Keycloak defaults): rotation needs per-request session
//    memoisation AND a single-flight refresh first (docs/auth.md residual).
// Pure: reads the shipped templates, no Keycloak, no network.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { buildTenantRealmDoc, PROVISIONER_SECRET_CLIENTS, REALM_PASSWORD_POLICY } from './realm-doc'

const HERE = dirname(fileURLToPath(import.meta.url))
const KC = join(HERE, '..', '..', '..', '..', '..', '..', 'docker', 'keycloak')
const load = (f: string) =>
  JSON.parse(readFileSync(join(KC, f), 'utf-8').split('__APEX_DOMAIN__').join('council.example'))
const base = load('realm-export.base.json')
const ops = load('realm-export.ops.json')

type Exec = { authenticator?: string; requirement: string; priority: number; flowAlias?: string; authenticatorFlow: boolean }
type Flow = { alias: string; authenticationExecutions: Exec[] }
const flow = (doc: { authenticationFlows: Flow[] }, alias: string): Flow => {
  const f = doc.authenticationFlows.find((x) => x.alias === alias)
  if (!f) throw new Error(`flow ${alias} absent`)
  return f
}

function tenantDoc() {
  return buildTenantRealmDoc({
    base,
    manifests: MODULE_MANIFESTS,
    config: { modules: {} },
    slug: 'musterstadt',
    realmName: 'musterstadt',
    tenantHost: 'rat.musterstadt.example',
    apexDomain: 'council.example',
    clientSecrets: Object.fromEntries(PROVISIONER_SECRET_CLIENTS.map((c) => [c, `secret-${c}`])),
    smtp: null,
  }) as unknown as { authenticationFlows: Flow[] } & Record<string, unknown>
}

describe.each([
  ['base template', () => base],
  ['ops template', () => ops],
  ['provisioned tenant realm', () => tenantDoc()],
])('step-up second factor gate: %s', (_n, doc) => {
  it('stepup-2fa has NO OTP form directly in it (a REQUIRED one makes Keycloak enrol and grant loa2)', () => {
    const f2 = flow(doc(), 'stepup-2fa')
    expect(f2.authenticationExecutions.filter((e) => e.authenticator === 'auth-otp-form')).toEqual([])
  })

  it('stepup-2fa = LoA-2 condition + one REQUIRED subflow "stepup-2fa second factor"', () => {
    const f2 = flow(doc(), 'stepup-2fa')
    const sub = f2.authenticationExecutions.filter((e) => e.authenticatorFlow)
    expect(sub).toHaveLength(1)
    expect(sub[0].flowAlias).toBe('stepup-2fa second factor')
    expect(sub[0].requirement).toBe('REQUIRED')
    expect(f2.authenticationExecutions.some((e) => e.authenticator === 'conditional-level-of-authentication')).toBe(true)
  })

  it('the subflow tries the OTP form first and DENIES otherwise (both ALTERNATIVE)', () => {
    const exs = [...flow(doc(), 'stepup-2fa second factor').authenticationExecutions].sort((a, b) => a.priority - b.priority)
    expect(exs.map((e) => [e.authenticator, e.requirement])).toEqual([
      ['auth-otp-form', 'ALTERNATIVE'],
      ['deny-access-authenticator', 'ALTERNATIVE'],
    ])
    expect(exs[0].priority).toBeLessThan(exs[1].priority)
  })
})

describe.each([
  ['base template', () => base],
  ['ops template', () => ops],
  ['provisioned tenant realm', () => tenantDoc() as never],
])('realm password and token hardening: %s', (_n, doc) => {
  it('has the password policy', () => {
    expect((doc() as any).passwordPolicy).toBe(REALM_PASSWORD_POLICY)
    expect(REALM_PASSWORD_POLICY).toBe('length(12) and notUsername and notEmail and passwordHistory(3)')
  })

  it('does not enable refresh-token rotation (parallel refreshes would log users out)', () => {
    expect((doc() as any).revokeRefreshToken ?? false).toBe(false)
    expect((doc() as any).refreshTokenMaxReuse ?? 0).toBe(0)
    expect(doc()).not.toHaveProperty('revokeRefreshToken')
    expect(doc()).not.toHaveProperty('refreshTokenMaxReuse')
  })
})

describe('PKCE', () => {
  it.each([
    ['base', () => base],
    ['tenant', () => tenantDoc() as never],
  ])('%s: gremion-ui enforces S256 and keeps its other attributes', (_n, doc) => {
    const ui = (doc() as any).clients.find((c: any) => c.clientId === 'gremion-ui')
    expect(ui.attributes['pkce.code.challenge.method']).toBe('S256')
    expect(ui.attributes['post.logout.redirect.uris']).toBeTruthy()
  })

  it('the login provider sends PKCE: the Auth.js check list is explicit, not a library default', () => {
    const src = readFileSync(join(HERE, '..', '..', '..', '..', 'auth.ts'), 'utf-8')
    expect(src).toMatch(/checks:\s*\[\s*'pkce'\s*,\s*'state'\s*\]/)
  })
})
