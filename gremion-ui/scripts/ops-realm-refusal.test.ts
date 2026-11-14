// The init refusal of an existing ops realm tells an ORIGIN mismatch (no in-place change; a new ops
// realm) from a TEMPLATE mismatch (upgrade runbook step 8a). See ops-realm-refusal.ts.
import { describe, expect, it } from 'vitest'
import { opsRealmFingerprint, opsRealmRefusal, storedPanelOrigin } from './ops-realm-refusal'

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

  it('a realm whose client does not say its origin, or that differs in both, is named as not known: both remedies are pointed at', () => {
    const noClient = refuse({ storedRedirectUris: undefined })
    expect(noClient.kind).toBe('unknown')
    expect(noClient.message).toContain('cannot change in place')
    expect(noClient.message).toContain('step 8a')
    const both = refuse({ storedFingerprint: opsRealmFingerprint(OLD_TEMPLATE, OTHER) })
    expect(both.kind).toBe('unknown')
  })

  it('the fingerprint is the one the shell computes: sha256(template, newline, origin)', () => {
    // printf 'a\nb' | sha256sum, which is `{ cat template; printf '\n%s' origin; } | sha256sum` in gremion-tenant
    expect(opsRealmFingerprint('a', 'b')).toBe('7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78')
  })
})
