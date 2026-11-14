// The init refusal of an existing ops realm tells an ORIGIN mismatch (no in-place change; a new ops
// realm) from a TEMPLATE mismatch (upgrade runbook step 8a). See ops-realm-refusal.ts.
import { describe, expect, it } from 'vitest'
import { opsRealmFingerprint, opsRealmRefusal, READ_ERROR_MAX, shortReadError, storedPanelOrigin } from './ops-realm-refusal'

const TEMPLATE = '{"realm":"platform","fixture":"current template"}'
const OLD_TEMPLATE = '{"realm":"platform","fixture":"previous template"}'
const ORIGIN = 'https://panel.example.com'
const OTHER = 'https://control.example.org'

const refuse = (over: Partial<Parameters<typeof opsRealmRefusal>[0]>) =>
  opsRealmRefusal({
    realm: 'platform',
    templateText: TEMPLATE,
    origin: ORIGIN,
    storedFingerprint: opsRealmFingerprint(TEMPLATE, OTHER),
    storedRedirectUris: [`${OTHER}/*`],
    ...over,
  })

describe('ops realm refusal', () => {
  it('reads the origin a realm was made for from its client redirect URI', () => {
    expect(storedPanelOrigin([`${OTHER}/*`])).toBe(OTHER)
    expect(storedPanelOrigin(undefined)).toBe('')
    expect(storedPanelOrigin([])).toBe('')
    expect(storedPanelOrigin(['https://x.example.org/no-wildcard'])).toBe('')
  })

  it('a realm made for another origin by the CURRENT template is an origin mismatch: no in-place change, and step 8a is not offered as the remedy', () => {
    const r = refuse({})
    expect(r.kind).toBe('origin')
    expect(r.message).toContain(`made for the panel origin ${OTHER}`)
    expect(r.message).toContain('cannot change in place')
    expect(r.message).toContain('needs a new ops realm')
    expect(r.message).toContain('step 8a of docs/ops/runbook/upgrade.md does not apply')
  })

  it('a realm made for THIS origin by an earlier template is a template mismatch: step 8a, with its precondition', () => {
    const r = refuse({ origin: OTHER, storedFingerprint: opsRealmFingerprint(OLD_TEMPLATE, OTHER) })
    expect(r.kind).toBe('template')
    expect(r.message).toContain('docs/ops/runbook/upgrade.md, step 8a')
    expect(r.message).toContain('precondition')
    expect(r.message).not.toContain('cannot change in place')
  })

  it('a client that was read and carries no redirect URI is "no redirect URI", not "unreadable": both remedies are pointed at', () => {
    const noUri = refuse({ storedRedirectUris: undefined })
    expect(noUri.kind).toBe('no-redirect')
    expect(noUri.message).toContain('carries no redirect URI of the form <origin>/*')
    expect(noUri.message).not.toContain('could not be read')
    expect(noUri.message).toContain('cannot change in place')
    expect(noUri.message).toContain('step 8a')
  })

  it('a client that could not be read says why, in a short masked form, and is not worded like "no redirect URI"', () => {
    const r = refuse({ storedRedirectUris: undefined, storedReadError: 'Keycloak Admin API error: 403 on GET /admin/realms/platform/clients?clientId=control-panel: forbidden' })
    expect(r.kind).toBe('unreadable')
    expect(r.message).toContain("the realm's control-panel client could not be read (Keycloak Admin API error: 403 on GET")
    expect(r.message).not.toContain('carries no redirect URI')
    expect(r.message).toContain('cannot change in place')
    expect(r.message).toContain('step 8a')
    // the error wins over a stale value: nothing was read
    expect(refuse({ storedReadError: 'HTTP error - 500 Internal Server Error' }).kind).toBe('unreadable')
  })

  it('a realm that differs in both names the stored origin and says both differ; step 8a is not offered alone', () => {
    const both = refuse({ storedFingerprint: opsRealmFingerprint(OLD_TEMPLATE, OTHER) })
    expect(both.kind).toBe('both')
    expect(both.message).toContain(`made for the panel origin ${OTHER}`)
    expect(both.message).toContain('the origin and the template both differ')
    expect(both.message).toContain('cannot change in place')
    expect(both.message).toContain('step 8a (read its precondition first)')
    expect(both.message).not.toContain('does not say which origin')
  })

  it('the short form of a read error is one line, masked and capped', () => {
    expect(shortReadError(new Error('HTTP error - 500\nsecond line with detail'))).toBe('HTTP error - 500')
    expect(shortReadError(new Error('connect failed for http://admin:hunter2@kc.internal:8080/auth/admin'))).toBe('connect failed for http://***@kc.internal:8080/auth/admin')
    expect(shortReadError(new Error('bad request: client_secret=abc123 and password: "xyz"'))).toBe('bad request: client_secret=*** and password: "***"')
    expect(shortReadError(new Error('Bearer eyJhbGciOi.payload.sig rejected'))).toBe('Bearer *** rejected')
    expect(shortReadError(new Error('x'.repeat(500))).length).toBe(READ_ERROR_MAX)
    expect(shortReadError(new Error(''))).toBe('no message')
    expect(shortReadError('plain text')).toBe('plain text')
    expect(shortReadError({ not: 'an error' })).toBe('unknown error')
  })

  it('the fingerprint is the one the shell computes: sha256(template, newline, origin)', () => {
    // printf 'a\nb' | sha256sum, which is `{ cat template; printf '\n%s' origin; } | sha256sum` in gremion-tenant
    expect(opsRealmFingerprint('a', 'b')).toBe('7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78')
  })
})
