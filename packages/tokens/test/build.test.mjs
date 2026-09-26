// The build: DTCG -> CSS custom properties for the default tenant, the
// per-palette override set, and the /* tokens:generated */ fences in a
// consumer stylesheet. TASK-082 brief section 6 items 3 and 8.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCss, buildPalettes, checkFences, loadTokens, resolveTokenValue, syncFences } from '../src/build.js'
import { cssText } from '../src/emit-css.js'
import { instanceAccentVars } from '../src/engine/accent.js'
import { flatten, mergeDocs } from '../src/model.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP_CSS = join(root, '..', '..', 'gremion-ui', 'src', 'app.css')

// The v8 literals the generated block replaces, verbatim from gremion-ui/src/app.css
// on kernel main 21ddf51 (:root lines 60-62, 81-84, 101-103, 107, 110-117, 120-122,
// 125, 128; .dark lines 145-148, 163-165, 168). "Renders unchanged" is asserted
// against this table, not against the file the build itself rewrites.
const V8_LIGHT = {
  '--font-display': '"Archivo Narrow", ui-sans-serif, system-ui, sans-serif',
  '--font-body': '"Inter", ui-sans-serif, system-ui, sans-serif',
  '--font-mono': '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  '--accent': 'oklch(42% 0.0154 265)',
  '--accent-ink': 'oklch(36% 0.0154 265)',
  '--accent-soft': 'oklch(93% 0.0049 265)',
  '--accent-faint': 'oklch(96% 0.0028 265)',
  '--sh-1': '0 1px 0 rgba(22, 21, 19, 0.04), 0 1px 2px rgba(22, 21, 19, 0.04)',
  '--sh-2': '0 1px 0 rgba(22, 21, 19, 0.05), 0 4px 14px -4px rgba(22, 21, 19, 0.08)',
  '--sh-3': '0 2px 0 rgba(22, 21, 19, 0.06), 0 14px 40px -14px rgba(22, 21, 19, 0.16)',
  '--scrim': 'rgba(22, 21, 19, 0.46)',
  '--r-xs': '3px',
  '--r-sm': '6px',
  '--r-md': '10px',
  '--r-lg': '14px',
  '--s-1': '4px',
  '--s-2': '8px',
  '--s-3': '12px',
  '--s-4': '16px',
  '--s-5': '20px',
  '--s-6': '24px',
  '--s-7': '32px',
  '--s-8': '48px',
  '--e-out': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  '--d-fast': '120ms',
  '--d-med': '220ms',
  '--touch-target-min': '44px',
  '--focus-ring': 'var(--accent)',
}
const V8_DARK = {
  '--accent': 'oklch(72% 0.0182 265)',
  '--accent-ink': 'oklch(78% 0.0154 265)',
  '--accent-soft': 'oklch(28% 0.0084 265)',
  '--accent-faint': 'oklch(22% 0.0056 265)',
  '--sh-1': '0 1px 0 rgba(0,0,0,0.4)',
  '--sh-2': '0 1px 0 rgba(0,0,0,0.5), 0 4px 14px -4px rgba(0, 0, 0, 0.4)',
  '--sh-3': '0 2px 0 rgba(0,0,0,0.6), 0 14px 40px -14px rgba(0, 0, 0, 0.6)',
  '--scrim': 'rgba(0, 0, 0, 0.66)',
}
// The colour-blind blocks, verbatim (app.css lines 175-212 on 21ddf51). They
// must follow the generated block unchanged (injection order, UX-033).
const V8_CB_BLOCKS = `/* Colorblind variants */
html.cb-rg {
  --pine:       oklch(52% 0.14 220);
  --pine-soft:  oklch(93% 0.04 220);
  --pine-ink:   oklch(36% 0.14 220);
  --rust:       oklch(58% 0.17 38);
  --rust-soft:  oklch(94% 0.06 40);
  --rust-ink:   oklch(40% 0.17 38);
  --ember:      oklch(62% 0.16 62);
  --ember-soft: oklch(95% 0.05 68);
  --ember-ink:  oklch(42% 0.16 62);
}
html.cb-rg.dark, html.cb-rg .dark {
  --pine:       oklch(68% 0.14 220);
  --pine-soft:  oklch(28% 0.05 220);
  --rust:       oklch(70% 0.17 38);
  --rust-soft:  oklch(28% 0.06 40);
  --ember:      oklch(74% 0.14 66);
  --ember-soft: oklch(28% 0.05 68);
}
html.cb-by {
  --accent:        oklch(48% 0.16 340);
  --accent-ink:    oklch(40% 0.16 340);
  --accent-soft:   oklch(93% 0.04 340);
  --accent-faint:  oklch(96% 0.02 340);
  /* §16 finding 2 — shift ember away from rust hue in cb-by */
  --ember:         oklch(56% 0.14 95);
  --ember-soft:    oklch(94% 0.05 95);
  --ember-ink:     oklch(40% 0.14 95);
}
html.cb-by.dark, html.cb-by .dark {
  --accent:        oklch(66% 0.16 340);
  --accent-ink:    oklch(76% 0.12 340);
  --accent-soft:   oklch(30% 0.08 340);
  --accent-faint:  oklch(22% 0.04 340);
  --ember:         oklch(70% 0.14 95);
  --ember-soft:    oklch(28% 0.06 95);
}`

/** Whitespace- and quote-insensitive CSS value (what the browser parses). @param {string} v */
const norm = (v) => v.replace(/\s+/g, '').replace(/"/g, '').toLowerCase()
/** @param {[string, string][]} decls */
const toMap = (decls) => Object.fromEntries(decls)

const tokens = loadTokens()
const built = buildCss(tokens)

test('build: every v8 literal the generated :root block replaces renders unchanged', () => {
  const light = toMap(built.light)
  for (const [name, v8] of Object.entries(V8_LIGHT)) {
    assert.ok(name in light, `${name} is no longer emitted`)
    assert.equal(norm(light[name]), norm(v8), `${name}: emitted ${light[name]} != v8 ${v8}`)
  }
})

test('build: the default accents are the app.css graphite literals, not instanceAccentVars(265)', () => {
  const light = toMap(built.light)
  const dark = toMap(built.dark)
  // Exact text, byte for byte (app.css:81-84 and :145-148 on 21ddf51).
  assert.equal(light['--accent'], 'oklch(42% 0.0154 265)')
  assert.equal(light['--accent-ink'], 'oklch(36% 0.0154 265)')
  assert.equal(light['--accent-soft'], 'oklch(93% 0.0049 265)')
  assert.equal(light['--accent-faint'], 'oklch(96% 0.0028 265)')
  assert.equal(dark['--accent'], 'oklch(72% 0.0182 265)')
  assert.equal(dark['--accent-ink'], 'oklch(78% 0.0154 265)')
  assert.equal(dark['--accent-soft'], 'oklch(28% 0.0084 265)')
  assert.equal(dark['--accent-faint'], 'oklch(22% 0.0056 265)')
  const simplified = instanceAccentVars(265)
  assert.notEqual(light['--accent'], simplified.light['--accent'])
  assert.notEqual(dark['--accent'], simplified.dark['--accent'])
})

test('build: the generated .dark block carries exactly the v8 dark overrides and nothing that equals light', () => {
  const dark = toMap(built.dark)
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(V8_DARK).sort())
  for (const [name, v8] of Object.entries(V8_DARK)) assert.equal(norm(dark[name]), norm(v8), name)
})

test('build: per-palette overrides are instanceAccentVars(H) for every palette hue, light and dark', () => {
  const palettes = buildPalettes(tokens.base)
  const hues = Object.values(palettes).map((p) => p.H).sort((a, b) => a - b)
  assert.deepEqual(hues, [200, 252, 300, 355])
  for (const [id, p] of Object.entries(palettes)) {
    const want = instanceAccentVars(p.H)
    assert.deepEqual(p.light, want.light, `${id} light`)
    assert.deepEqual(p.dark, want.dark, `${id} dark`)
  }
})

test('build: per-palette overrides come from the engine, not a copied table (a new hue derives too)', () => {
  const withExtra = mergeDocs(tokens.base, {
    core: { hue: { fixture: { $type: 'number', $value: 123, $extensions: { 'org.gremion': { palette: true } } } } },
  })
  const palettes = buildPalettes(withExtra)
  assert.deepEqual(palettes.fixture?.light, instanceAccentVars(123).light)
  assert.deepEqual(palettes.fixture?.dark, instanceAccentVars(123).dark)
  /** @type {number[]} */
  const seen = []
  buildPalettes(tokens.base, {
    engine: (H) => {
      seen.push(H)
      return instanceAccentVars(H)
    },
  })
  assert.deepEqual(seen.sort((a, b) => a - b), [200, 252, 300, 355])
})

test('fences: the consumer stylesheet (gremion-ui app.css) is in sync with the build', () => {
  const css = readFileSync(APP_CSS, 'utf8')
  assert.deepEqual(checkFences(css, built), [])
})

test('fences: the colour-blind blocks follow the generated block, byte-for-byte unchanged', () => {
  const css = readFileSync(APP_CSS, 'utf8').replace(/\r\n/g, '\n')
  const cb = css.indexOf(V8_CB_BLOCKS)
  assert.ok(cb > 0, 'the v8 colour-blind blocks are not in app.css unchanged')
  const lightEnd = css.indexOf('/* tokens:generated:light:end */')
  const darkEnd = css.indexOf('/* tokens:generated:dark:end */')
  assert.ok(lightEnd > 0 && darkEnd > lightEnd, 'fences missing or out of order')
  assert.ok(cb > darkEnd, 'colour-blind overrides must come after the generated blocks')
})

test('fences: a stale, missing or duplicated fence is reported; sync rewrites only the fenced lines', () => {
  const css = readFileSync(APP_CSS, 'utf8')
  const stale = css.replace('--s-1: 4px;', '--s-1: 5px;')
  assert.notEqual(stale, css)
  assert.ok(checkFences(stale, built).some((p) => p.includes('light')))
  assert.equal(syncFences(stale, built), css)
  const missing = css.replace('/* tokens:generated:dark:begin', '/* nope')
  assert.ok(checkFences(missing, built).some((p) => p.includes('dark')))
  assert.throws(() => syncFences(missing, built), /dark/)
  const outside = css.replace('/* Colorblind variants */', '/* Colorblind variants */\n/* tokens:generated:light:begin */')
  assert.ok(checkFences(outside, built).length > 0)
})

test('fences: the hand-written v8 neutrals the token file references still match app.css', () => {
  const css = readFileSync(APP_CSS, 'utf8')
  const lightBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const darkBlock = css.match(/\n\.dark\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const lightU = flatten(tokens.base)
  const darkU = flatten(mergeDocs(tokens.base, tokens.dark))
  let checked = 0
  for (const [u, block, mode] of /** @type {const} */ ([
    [lightU, lightBlock, 'light'],
    [darkU, darkBlock, 'dark'],
  ])) {
    for (const t of u.values()) {
      if (!t.ext.handWritten || !t.ext.css) continue
      const m = block.match(new RegExp(`${t.ext.css}\\s*:\\s*([^;]+);`))
      assert.ok(m, `${mode}: ${t.ext.css} is not hand-written in app.css`)
      assert.equal(norm(resolveTokenValue(u, t.path)), norm(m[1]), `${mode}: ${t.ext.css}`)
      checked++
    }
  }
  assert.equal(checked, 12)
})

test('type and space tokens: s-1..s-8 are 4-8-12-16-20-24-32-48, section-gap is 64px, the type scale is complete', () => {
  const u = flatten(tokens.base)
  const steps = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => cssText(u, `core.space.s-${n}`))
  assert.deepEqual(steps, ['4px', '8px', '12px', '16px', '20px', '24px', '32px', '48px'])
  assert.equal(resolveTokenValue(u, 'semantic.space.section-gap'), '64px')
  const light = toMap(built.light)
  assert.equal(light['--space-section-gap'], '64px')
  for (const step of ['display', 'title', 'heading', 'body', 'label', 'caption', 'mono-label']) {
    const t = u.get(`core.typography.${step}`)
    assert.equal(t?.type, 'typography', step)
    assert.ok(light[`--type-${step}`], `--type-${step} emitted`)
  }
})
