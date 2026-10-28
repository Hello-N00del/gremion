import { describe, expect, it } from 'vitest'
import { opsAccountConsoleUrl, opsOperatorEnrolmentNotice } from './ops-enrolment'

// The control panel and Grafana always sign in at loa2 and the step-up flow is
// OTP-or-deny, so a new operator (UPDATE_PASSWORD + CONFIGURE_TOTP pending, no
// OTP yet) can only enrol through a plain loa1 sign-in: the platform realm's
// account console. `operator add --no-mail` must say so.
describe('ops operator enrolment notice', () => {
  it('derives the account console URL from the platform domain', () => {
    expect(opsAccountConsoleUrl('ops.example.org')).toBe('https://ops.example.org/auth/realms/platform/account')
  })

  it('falls back to a placeholder that names the issuer when the platform domain is unknown', () => {
    expect(opsAccountConsoleUrl(undefined)).toBe('<PANEL_OIDC_ISSUER>/account')
    expect(opsAccountConsoleUrl('')).toBe('<PANEL_OIDC_ISSUER>/account')
  })

  it('tells the operator to enrol at the account console, not at the panel or Grafana', () => {
    const msg = opsOperatorEnrolmentNotice('op@example.org', 'ops.example.org')
    expect(msg).toContain('https://ops.example.org/auth/realms/platform/account')
    expect(msg).toMatch(/TOTP/)
    expect(msg).toMatch(/loa2/)
    expect(msg).toContain('op@example.org')
    // the old advice (enrol at first sign-in, anywhere) is gone
    expect(msg).not.toMatch(/at first sign-in$/)
  })
})

// The CLI must actually print the notice (a helper nobody calls guards nothing).
describe('operator add wiring', () => {
  it('tenant-provision prints the enrolment notice, not the old first-sign-in advice', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('scripts/tenant-provision.ts', 'utf8')
    expect(src).toContain('opsOperatorEnrolmentNotice(email, process.env.PLATFORM_DOMAIN)')
    expect(src).not.toContain('TOTP configured at first sign-in')
  })
})
