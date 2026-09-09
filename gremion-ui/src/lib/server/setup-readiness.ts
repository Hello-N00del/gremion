// src/lib/server/setup-readiness.ts
//
// t291-setup-brand-legal — the go-live readiness gate for the first-run setup
// wizard. A pure predicate over a resolved GremionConfig (no DB, no fs, no
// tenant context) so it can run identically server-side (the wizard's Abschluss
// guard) and in a unit test driven through parseConfig({...}).
//
// A deployment is go-live ready iff BOTH:
//   • the Marke (brand) carries a non-empty product name (brand.product), AND
//   • all three Rechtstexte (legal) have had their per-tenant placeholder
//     replaced — i.e. none of datenschutz_html / impressum_html /
//     barrierefreiheit_html still contains PLACEHOLDER_MARKER. The marker is the
//     single shared signal (config.ts owns it) that a legal text is still the
//     neutral, un-edited "Entwurf" placeholder rather than the institution's
//     real copy.
import { PLACEHOLDER_MARKER, type GremionConfig } from './config'

/**
 * Whether the deployment has the minimum Marke + Rechtstexte configuration to
 * go live (the wizard's Abschluss/go-live action is gated on this).
 *
 * Returns `false` while the product name is blank, or while ANY of the three
 * legal texts still carries the per-tenant placeholder marker; `true` only once
 * the brand product is set AND all three legal texts are free of the marker.
 */
export function isGoLiveReady(config: GremionConfig): boolean {
  const hasProduct = config.brand.product.trim().length > 0
  if (!hasProduct) return false

  const legalTexts = [
    config.legal.datenschutz_html,
    config.legal.impressum_html,
    config.legal.barrierefreiheit_html,
  ]
  const allLegalFinalised = legalTexts.every((html) => !html.includes(PLACEHOLDER_MARKER))

  return allLegalFinalised
}
