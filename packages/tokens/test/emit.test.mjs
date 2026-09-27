// The CSS emitter: DTCG values -> CSS custom-property text. Aliases to an
// emitted token become var() so the cascade (per-tenant accent injection,
// colour-blind overrides, density/radius toggles) still reaches every
// consumer; aliases to a non-emitted core value resolve to its literal.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cssText, emitDeclarations } from '../src/emit-css.js'
import { flatten } from '../src/model.js'

/** @param {Record<string, any>} doc */
const U = (doc) => flatten(doc)
const css = (/** @type {string} */ v, extra = {}) => ({ $extensions: { 'org.gremion': { css: v, ...extra } } })

test('emit: colours -- oklch as percent lightness, srgb as hex or rgba', () => {
  const u = U({
    core: {
      a: { $type: 'color', $value: { colorSpace: 'oklch', components: [0.42, 0.0154, 265] } },
      b: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.0863, 0.0824, 0.0745], alpha: 0.46 } },
      c: { $type: 'color', $value: { colorSpace: 'srgb', components: [1, 1, 1] } },
      d: { $type: 'color', $value: { colorSpace: 'oklch', components: [0.5, 0.1, 30], alpha: 0.5 } },
    },
  })
  assert.equal(cssText(u, 'core.a'), 'oklch(42% 0.0154 265)')
  assert.equal(cssText(u, 'core.b'), 'rgba(22, 21, 19, 0.46)')
  assert.equal(cssText(u, 'core.c'), '#ffffff')
  assert.equal(cssText(u, 'core.d'), 'oklch(50% 0.1 30 / 0.5)')
})

test('emit: an unsupported colour space fails loudly instead of emitting something approximate', () => {
  const u = U({ core: { a: { $type: 'color', $value: { colorSpace: 'display-p3', components: [1, 0, 0] } } } })
  assert.throws(() => cssText(u, 'core.a'), /core\.a.*display-p3/)
})

test('emit: dimension, duration, cubicBezier, number, fontWeight, fontFamily quoting', () => {
  const u = U({
    core: {
      d: { $type: 'dimension', $value: { value: 4, unit: 'px' } },
      r: { $type: 'dimension', $value: { value: 1.5, unit: 'rem' } },
      t: { $type: 'duration', $value: { value: 120, unit: 'ms' } },
      e: { $type: 'cubicBezier', $value: [0.2, 0.8, 0.2, 1] },
      n: { $type: 'number', $value: 1.5 },
      w: { $type: 'fontWeight', $value: 'semi-bold' },
      f: { $type: 'fontFamily', $value: ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'] },
    },
  })
  assert.equal(cssText(u, 'core.d'), '4px')
  assert.equal(cssText(u, 'core.r'), '1.5rem')
  assert.equal(cssText(u, 'core.t'), '120ms')
  assert.equal(cssText(u, 'core.e'), 'cubic-bezier(0.2, 0.8, 0.2, 1)')
  assert.equal(cssText(u, 'core.n'), '1.5')
  assert.equal(cssText(u, 'core.w'), '600')
  assert.equal(cssText(u, 'core.f'), '"JetBrains Mono", ui-monospace, "SF Mono", "Menlo", monospace')
})

test('emit: shadow layers -- zero lengths as 0, spread only when non-zero', () => {
  const px = (/** @type {number} */ v) => ({ value: v, unit: 'px' })
  const col = { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.4 }
  const u = U({
    core: {
      s: {
        $type: 'shadow',
        $value: [
          { color: col, offsetX: px(0), offsetY: px(1), blur: px(0), spread: px(0) },
          { color: col, offsetX: px(0), offsetY: px(4), blur: px(14), spread: px(-4) },
        ],
      },
    },
  })
  assert.equal(cssText(u, 'core.s'), '0 1px 0 rgba(0, 0, 0, 0.4), 0 4px 14px -4px rgba(0, 0, 0, 0.4)')
})

test('emit: an alias to an emitted token becomes var(); to a non-emitted core token, its literal', () => {
  const u = U({
    core: {
      g: { $type: 'color', $value: { colorSpace: 'oklch', components: [0.42, 0.0154, 265] } },
      s6: { $type: 'dimension', $value: { value: 24, unit: 'px' }, ...css('--s-6') },
    },
    semantic: {
      accent: { $type: 'color', $value: '{core.g}', ...css('--accent') },
      inset: { $type: 'dimension', $value: '{core.s6}' },
      surface: { $type: 'color', $value: '{core.g}', ...css('--surface', { handWritten: true }) },
    },
    component: {
      ring: { $type: 'color', $value: '{semantic.accent}', ...css('--ring') },
      pad: { $type: 'dimension', $value: '{semantic.inset}', ...css('--pad') },
      bg: { $type: 'color', $value: '{semantic.surface}', ...css('--bg') },
    },
  })
  assert.equal(cssText(u, 'semantic.accent'), 'oklch(42% 0.0154 265)')
  assert.equal(cssText(u, 'component.ring'), 'var(--accent)')
  // semantic.inset has no css var, so the chain continues to core.s6, which has one.
  assert.equal(cssText(u, 'component.pad'), 'var(--s-6)')
  // A hand-written var is not emitted, but it is still the thing to reference.
  assert.equal(cssText(u, 'component.bg'), 'var(--surface)')
  const names = emitDeclarations(u).map(([n]) => n)
  assert.deepEqual(names, ['--s-6', '--accent', '--ring', '--pad', '--bg'])
})

test('emit: typography -> font shorthand plus a tracking companion; aliases carry both', () => {
  const u = U({
    core: {
      font: { body: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'], ...css('--font-body') } },
      w: { $type: 'fontWeight', $value: 500 },
      t: {
        $type: 'typography',
        $value: {
          fontFamily: '{core.font.body}',
          fontSize: { value: 12, unit: 'px' },
          fontWeight: '{core.w}',
          letterSpacing: { value: 0, unit: 'px' },
          lineHeight: 1.4,
        },
      },
    },
    semantic: { label: { $type: 'typography', $value: '{core.t}', ...css('--type-label') } },
    component: { f: { $type: 'typography', $value: '{semantic.label}', ...css('--field-label-font') } },
  })
  assert.deepEqual(emitDeclarations(u).slice(1), [
    ['--type-label', '500 12px/1.4 var(--font-body)'],
    ['--type-label-tracking', '0px'],
    ['--field-label-font', 'var(--type-label)'],
    ['--field-label-font-tracking', 'var(--type-label-tracking)'],
  ])
})

test('emit: an alias that does not resolve, a cycle, or a type mismatch throws (no raw fallback)', () => {
  assert.throws(() => cssText(U({ semantic: { a: { $type: 'color', $value: '{core.nope}' } } }), 'semantic.a'), /core\.nope/)
  assert.throws(
    () =>
      cssText(
        U({ core: { a: { $type: 'number', $value: '{core.b}' }, b: { $type: 'number', $value: '{core.a}' } } }),
        'core.a',
      ),
    /cycle/,
  )
  assert.throws(
    () =>
      cssText(
        U({ core: { a: { $type: 'number', $value: 1 } }, semantic: { b: { $type: 'color', $value: '{core.a}' } } }),
        'semantic.b',
      ),
    /type/,
  )
})
