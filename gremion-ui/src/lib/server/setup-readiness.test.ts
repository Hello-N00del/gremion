import { describe, expect, it } from 'vitest'
import { parseConfig, PLACEHOLDER_MARKER } from './config'
import { isGoLiveReady } from './setup-readiness'

// t291-setup-brand-legal — go-live readiness gate for the first-run wizard.
// Pure predicate, no DB (mirrors terms.test.ts / config.test.ts): inputs are
// driven through the exported, DB-free parseConfig({...}) so we exercise the
// real merge/round-trip, and the shared PLACEHOLDER_MARKER is imported from
// config.ts so predicate + test agree on a single source.
//
// A config is go-live ready iff the Marke (brand) carries a product name AND
// all three Rechtstexte (legal) have had their placeholder replaced — i.e. none
// of datenschutz_html / impressum_html / barrierefreiheit_html still contains
// the per-tenant placeholder marker.

// Legal HTML with the placeholder marker fully replaced by real (test) copy.
const REAL_DATENSCHUTZ = '<h3>Datenschutz</h3><p>Echte Angaben.</p>'
const REAL_IMPRESSUM = '<h3>Impressum</h3><p>Echte Pflichtangaben.</p>'
const REAL_BARRIEREFREIHEIT = '<h3>Barrierefreiheit</h3><p>Echte Erklärung.</p>'

const completeLegal = {
  datenschutz_html: REAL_DATENSCHUTZ,
  impressum_html: REAL_IMPRESSUM,
  barrierefreiheit_html: REAL_BARRIEREFREIHEIT,
}

describe('isGoLiveReady', () => {
  it('(a) is NOT ready when brand.product is empty (even with complete legal texts)', () => {
    const cfg = parseConfig({
      brand: { product: '' },
      legal: completeLegal,
    })
    expect(isGoLiveReady(cfg)).toBe(false)
  })

  it('(b) is NOT ready when any legal text still contains the placeholder marker', () => {
    // The default config legal texts all carry the marker; supplying only a
    // product name leaves the placeholder legal copy in place via parseConfig's
    // merge onto DEFAULT_CONFIG.
    const cfg = parseConfig({ brand: { product: 'Musterstadt' } })
    // Sanity: the merged default legal really does still carry the marker.
    expect(cfg.legal.datenschutz_html).toContain(PLACEHOLDER_MARKER)
    expect(isGoLiveReady(cfg)).toBe(false)
  })

  it('(b) is NOT ready when exactly one of the three legal texts still has the marker', () => {
    const cfg = parseConfig({
      brand: { product: 'Musterstadt' },
      legal: {
        datenschutz_html: REAL_DATENSCHUTZ,
        impressum_html: `${PLACEHOLDER_MARKER}\n<h3>Impressum</h3>`,
        barrierefreiheit_html: REAL_BARRIEREFREIHEIT,
      },
    })
    expect(isGoLiveReady(cfg)).toBe(false)
  })

  it('(c) IS ready when brand.product is set AND all three legal texts are free of the marker', () => {
    const cfg = parseConfig({
      brand: { product: 'Musterstadt' },
      legal: completeLegal,
    })
    expect(isGoLiveReady(cfg)).toBe(true)
  })

  it('(a) the bare default config is NOT ready (empty product + placeholder legal)', () => {
    const cfg = parseConfig({})
    expect(isGoLiveReady(cfg)).toBe(false)
  })

  it('treats a whitespace-only product name as not set', () => {
    const cfg = parseConfig({
      brand: { product: '   ' },
      legal: completeLegal,
    })
    expect(isGoLiveReady(cfg)).toBe(false)
  })
})
