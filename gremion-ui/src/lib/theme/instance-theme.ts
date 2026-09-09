// src/lib/theme/instance-theme.ts
//
// #288 — curated per-tenant accent palettes ("the framework's colour vocabulary").
//
// One designed, AA-coherent theme per instance. Same OKLCH formula as app.css —
// ONLY the hue (H) changes, so the whole accent ramp (accent / ink / soft /
// faint, light + dark) derives together and stays contrast-safe. This is the
// LOCKED design decision (HANDOVER-v8 Part E): tenants pick from a CURATED set,
// NOT a free-form OKLCH/hex picker. Hues deliberately avoid the warm
// danger/caution band (~20-60°) so the accent never collides with the
// rust/ember status pills.
//
// Rendering contract (HANDOVER-v8 Part E + prototype web/tenancy.jsx
// applyInstanceTheme): the derived ramp is injected as a SINGLE
// `<style id="__instance-theme">` in the document <head> AFTER app.css, at :root
// / .dark level — NOT inline on the shell wrapper. That ordering matters twice:
//   1. it sits after app.css so the per-tenant :root accent wins by source order
//      at EQUAL specificity (the default navy tokens are plain :root too);
//   2. the a11y colour-blind overrides (html.cb-rg / html.cb-by) keep HIGHER
//      specificity and therefore still win — accessibility first. (The previous
//      inline `style:--accent` on the shell <div> INVERTED this and overrode the
//      cb-* accent for colour-blind users; that is the bug this module closes.)
//
// Client-safe: NO server-only imports — bundled into the client (the helpers are
// pure). The injection happens server-side in hooks.server.ts (tenantBrandStyleHandle).
//
// gremion#22 (theming parity): the config/brand CONTRACT is curated-id-only
// going forward — `GremionConfig.brand.palette` (lib/server/config.ts) and the
// client `Brand.palette` (lib/brand.ts) may only ever carry a `PaletteId` or
// `null`, validated by `resolvePaletteId` in lib/server/brand.ts
// brandFromConfig. The pre-#22 contract (`brand.accent`) accepted a curated
// id, a bare OKLCH hue number, or an oklch()/hsl() string — that freeform
// grammar is DEPRECATED but still understood read-only by `resolveAccentHue`
// (kept here because it is also this module's hue-derivation engine for CSS
// rendering) and migrated onto a curated id by `legacyAccentToPalette` at
// config read-time (config.ts mergeStoredBrand), the same treatment the
// product vertical gave its own retired `accent` key.

/** A curated tenant palette: only the hue (H) varies; the ramp derives from it. */
export interface TenantPalette {
  /** Human hue name (display only — e.g. a future palette picker). */
  hue: string
  /** OKLCH hue angle (degrees) — the single variable of the curated formula. */
  H: number
}

/** The curated palette ids — the only values `brand.palette` may carry
 *  (gremion#22). Kept as an explicit literal union (not `keyof typeof
 *  TENANT_PALETTES`) so the registry below can be typed `Record<PaletteId, …>`
 *  and stay exhaustive. */
export type PaletteId = 'stura' | 'stadt' | 'club' | 'fara'

/**
 * The curated set (HANDOVER-v8 Part E, LOCKED). Keyed by instance id so a config
 * can name a palette without restating the hue. The Raspberry hue (355) sits
 * deliberately OFF the warm 20-60° band that collides with rust/ember. Product
 * names are NOT stored here — they are per-tenant brand (resolveBrand), kept out
 * of source per the brand-neutralization guard (brand.guard.test.ts).
 */
export const TENANT_PALETTES: Record<PaletteId, TenantPalette> = {
  stura: { hue: 'Navy', H: 252 },
  stadt: { hue: 'Aubergine', H: 300 },
  club: { hue: 'Raspberry', H: 355 },
  fara: { hue: 'Teal', H: 200 },
}

/** The curated palette ids, in registry order. */
export const PALETTE_IDS = Object.keys(TENANT_PALETTES) as ReadonlyArray<PaletteId>

/** Type guard: is `v` a curated palette id? */
export function isPaletteId(v: string): v is PaletteId {
  return Object.prototype.hasOwnProperty.call(TENANT_PALETTES, v)
}

/** The kernel default hue — graphite (the neutral `gremion` instance, hue 265).
 *  Matches the app.css static accent default (design handover v10, Part D). This
 *  is no longer the stura navy originator; stura's navy (252) is now a distinct
 *  curated palette, so the runtime injection agrees with the CSS default. */
export const DEFAULT_ACCENT_HUE = 265

/**
 * Accent ramp for a given hue — mirrors the `--accent*` block of app.css
 * (and prototype web/tenancy.jsx `instanceAccentVars`) EXACTLY. Only H varies;
 * lightness/chroma per step are fixed so every hue derives an AA-coherent ramp.
 */
export function instanceAccentVars(H: number): {
  light: Record<string, string>
  dark: Record<string, string>
} {
  return {
    light: {
      '--accent': `oklch(42% 0.11 ${H})`,
      '--accent-ink': `oklch(36% 0.11 ${H})`,
      '--accent-soft': `oklch(93% 0.035 ${H})`,
      '--accent-faint': `oklch(96% 0.02 ${H})`,
    },
    dark: {
      '--accent': `oklch(72% 0.13 ${H})`,
      '--accent-ink': `oklch(78% 0.11 ${H})`,
      '--accent-soft': `oklch(28% 0.06 ${H})`,
      '--accent-faint': `oklch(22% 0.04 ${H})`,
    },
  }
}

/**
 * Resolve a `brand.palette`/legacy `brand.accent` value to a curated hue
 * angle, or `null` when it should fall through to the default navy (app.css
 * tokens, no injection). This is the module's CSS hue-derivation engine —
 * gremion#22 kept it (rather than retiring it like the product vertical did)
 * because the kernel still renders via a computed `<style>` tag, not a `data-instance`
 * attribute + CSS registry, so a hue is what CSS-injection time needs
 * regardless of how strict the config CONTRACT is. `legacyAccentToPalette`
 * below reuses this same parsing to migrate a stored legacy value onto a
 * curated id.
 *
 * Accepts, in order:
 *   - a curated palette id ('stura' | 'stadt' | 'club' | 'fara') → its H;
 *   - a bare hue number ('300', '252.5') in [0, 360];
 *   - an OKLCH/HSL string whose hue we can read ('oklch(42% 0.11 300)',
 *     'hsl(300 40% 50%)') → that hue.
 *
 * Anything else (notably a free-form hex like '#7c3aed') falls back to `null`
 * with a warning: the LOCKED decision is a curated, hue-only palette — a raw hex
 * is intentionally NOT honoured (it would re-introduce the free-form picker the
 * design rejected, and a fixed-chroma OKLCH ramp can't faithfully represent an
 * arbitrary sRGB colour). `null`/empty → `null` (default tenant #1 renders
 * byte-identically off app.css).
 */
export function resolveAccentHue(accent: string | null | undefined): number | null {
  if (accent == null) return null
  const v = accent.trim()
  if (v.length === 0) return null

  // Curated palette id.
  const lower = v.toLowerCase()
  if (isPaletteId(lower)) return TENANT_PALETTES[lower].H

  // Bare hue number.
  if (/^[0-9]+(\.[0-9]+)?$/.test(v)) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0 && n <= 360) return n
  }

  // OKLCH: oklch(L C H[ / a]) — hue is the 3rd component.
  const oklch = v.match(/oklch\(\s*[\d.]+%?\s+[\d.]+\s+([\d.]+)/i)
  if (oklch) {
    const n = Number(oklch[1])
    if (Number.isFinite(n) && n >= 0 && n <= 360) return n
  }

  // HSL: hsl(H S% L%) — hue is the 1st component.
  const hsl = v.match(/hsla?\(\s*([\d.]+)/i)
  if (hsl) {
    const n = Number(hsl[1])
    if (Number.isFinite(n) && n >= 0 && n <= 360) return n
  }

  console.warn(
    `[instance-theme] brand.accent '${accent}' is not a curated palette id, hue number, or oklch/hsl colour — ` +
      `falling back to the default accent. The #288 palette set is curated/hue-only (a raw hex is not supported).`,
  )
  return null
}

/**
 * Validate a config `brand.palette` value against the curated set (gremion#22
 * — the config/brand contract is id-only going forward, mirroring the product
 * vertical's own `resolvePaletteId`). Accepts a curated id (case/whitespace tolerated);
 * `null`/empty → `null` (default rendering, byte-identical tenant #1).
 * Anything else — including the deprecated freeform accent grammar (bare
 * hues, oklch()/hsl(), hex) — resolves to `null` with a server-side warning.
 * A stored legacy value is migrated onto a curated id BEFORE it reaches this
 * validator (config.ts mergeStoredBrand → legacyAccentToPalette), so in
 * practice this only ever sees an already-curated id or null; it stays
 * strict as a defence-in-depth gate against a hand-edited config file.
 */
export function resolvePaletteId(value: string | null | undefined): PaletteId | null {
  if (value == null) return null
  const v = value.trim().toLowerCase()
  if (v.length === 0) return null
  if (isPaletteId(v)) return v
  console.warn(
    `[instance-theme] brand.palette '${value}' is not a curated palette id ` +
      `(${PALETTE_IDS.join('|')}) — falling back to the default accent rendering.`,
  )
  return null
}

/**
 * Read-time migration of the DEPRECATED freeform `brand.accent` config key
 * (config.ts mergeStoredBrand) onto the curated `PaletteId` set that
 * `brand.palette` now carries exclusively. Reuses `resolveAccentHue`'s
 * parsing (curated id / bare hue / oklch()/hsl() string) to get a hue, then
 * maps that hue onto whichever curated palette owns it by EQUALITY. A hue no
 * curated palette carries (an arbitrary hue, a raw hex, a colour name) has no
 * curated representation and drops to `null` with a warning — the same
 * fallback `resolveAccentHue` itself already applies for outright-unparseable
 * input.
 */
export function legacyAccentToPalette(accent: string | null | undefined): PaletteId | null {
  const H = resolveAccentHue(accent)
  if (H == null) return null
  const byHue = PALETTE_IDS.find((id) => TENANT_PALETTES[id].H === H)
  if (byHue) return byHue
  console.warn(
    `[config] legacy brand.accent '${accent}' has no curated palette mapping (hue ${H}) — ` +
      `dropping it (default accent rendering). Set brand.palette to one of ` +
      `${PALETTE_IDS.join('|')} instead.`,
  )
  return null
}

/** Serialise a vars record to a CSS declaration block body (`--k:v;`). */
function decl(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, val]) => `${k}:${val};`)
    .join('')
}

/**
 * The `:root{…}\n.dark{…}` CSS for a hue. Plain `:root`/`.dark` selectors at
 * EQUAL specificity to app.css — it wins only because it is injected AFTER, and
 * the higher-specificity `html.cb-*` overrides still beat it (a11y first).
 */
export function instanceThemeCss(H: number): string {
  const v = instanceAccentVars(H)
  return `:root{${decl(v.light)}}\n.dark{${decl(v.dark)}}`
}

/**
 * The full `<style id="__instance-theme">…</style>` tag for a `brand.palette`
 * value (or a legacy freeform accent — `resolveAccentHue` still accepts
 * both), or `''` when it resolves to the default (no injection →
 * byte-identical tenant #1). This is what hooks.server.ts inserts before
 * `</head>`.
 */
export function instanceThemeStyleTag(palette: string | null | undefined): string {
  const H = resolveAccentHue(palette)
  if (H == null) return ''
  return `<style id="__instance-theme">${instanceThemeCss(H)}</style>`
}
