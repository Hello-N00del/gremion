// The init refusal of an existing ops realm tells an ORIGIN mismatch (no in-place change; a new ops
// realm) from a TEMPLATE mismatch (upgrade runbook step 8a). See ops-realm-refusal.ts.
import { describe, expect, it } from 'vitest'
import { opsRealmFingerprint, opsRealmRefusal, READ_ERROR_MAX, readStoredPanelClient, shortReadError, storedPanelOrigin } from './ops-realm-refusal'

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

  it('masks the other credential spellings too: access_token, a *_PASSWORD variable, JSON values, a quoted value with a space, an Authorization header', () => {
    expect(shortReadError(new Error('rejected: {"access_token":"tok-1 x","refresh_token":"tok2","expires_in":60}'))).toBe('rejected: {"access_token":"***","refresh_token":"***","expires_in":60}')
    expect(shortReadError(new Error('env KEYCLOAK_ADMIN_PASSWORD=hunter3 was refused'))).toBe('env KEYCLOAK_ADMIN_PASSWORD=*** was refused')
    expect(shortReadError(new Error('secret = "pa ss" and next'))).toBe('secret = "***" and next')
    expect(shortReadError(new Error("api_key: 'k 1' end"))).toBe("api_key: '***' end")
    expect(shortReadError(new Error('401 for Authorization: Basic dXNlcjpwYXNz'))).toBe('401 for Authorization: ***')
    expect(shortReadError(new Error('HTTP error - 500 Internal Server Error'))).toBe('HTTP error - 500 Internal Server Error')
  })

  it("reading the realm's control-panel client: an answer gives its redirect URIs, a failed read gives a short error and no URIs (unreadable is not 'no redirect URI')", async () => {
    const ok = await readStoredPanelClient(async () => [{ redirectUris: [`${OTHER}/*`] }], 'platform')
    expect(ok).toEqual({ storedRedirectUris: [`${OTHER}/*`], storedReadError: undefined })
    const none = await readStoredPanelClient(async () => [], 'platform')
    expect(none).toEqual({ storedRedirectUris: undefined, storedReadError: undefined })
    const paths: string[] = []
    const failed = await readStoredPanelClient(async (method, path) => {
      paths.push(`${method} ${path}`)
      throw new Error('Keycloak Admin API error: 403 on GET\nsecond line http://u:pw@kc.internal/x')
    }, 'platform')
    expect(paths).toEqual(['GET /admin/realms/platform/clients?clientId=control-panel'])
    expect(failed.storedRedirectUris).toBeUndefined()
    expect(failed.storedReadError).toBe('Keycloak Admin API error: 403 on GET')
    // the failure reaches the refusal as "unreadable", not as "carries no redirect URI"
    expect(refuse({ ...failed }).kind).toBe('unreadable')
    expect(refuse({ ...none }).kind).toBe('no-redirect')
    // an answer that is not a list is unreadable too
    const odd = await readStoredPanelClient(async () => '<html>login</html>', 'platform')
    expect(odd.storedReadError).toBeDefined()
  })

  it('the fingerprint is the one the shell computes: sha256(template, newline, origin)', () => {
    // printf 'a\nb' | sha256sum, which is `{ cat template; printf '\n%s' origin; } | sha256sum` in gremion-tenant
    expect(opsRealmFingerprint('a', 'b')).toBe('7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78')
  })
})
