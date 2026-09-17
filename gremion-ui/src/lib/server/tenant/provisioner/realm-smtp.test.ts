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
