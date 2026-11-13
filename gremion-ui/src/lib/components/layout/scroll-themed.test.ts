import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The navigation scroll areas carry the shared themed scrollbar. Without it the
 * browser default (a wide, light-grey bar) shows in the sidebar and the drawer
 * and does not follow the theme. cwd = gremion-ui/ when vitest runs.
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8')

const css = read('src/app.css')
const ruleBody = (selector: string): string => {
  const start = css.indexOf(selector + ' {')
  if (start < 0) return ''
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
}
const HARD_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i

describe('.scroll-themed utility', () => {
  test('is defined with a thin scrollbar and token-based colours', () => {
    const body = ruleBody('.scroll-themed')
    expect(body, 'rule .scroll-themed exists').not.toBe('')
    expect(body).toMatch(/scrollbar-width:\s*thin/)
    expect(body).toMatch(/scrollbar-color:[^;]*var\(--/)
    expect(body).toMatch(/scrollbar-color:[^;]*transparent/)
    expect(body, 'no hard-coded colour').not.toMatch(HARD_COLOUR)
  })

  test('has a WebKit fallback with a transparent track and a stronger hover thumb', () => {
    expect(ruleBody('.scroll-themed::-webkit-scrollbar')).toMatch(/width:\s*8px/)
    expect(ruleBody('.scroll-themed::-webkit-scrollbar-track')).toMatch(/background:\s*transparent/)
    expect(ruleBody('.scroll-themed::-webkit-scrollbar-thumb')).toMatch(/border-radius/)
    expect(ruleBody('.scroll-themed::-webkit-scrollbar-thumb:hover')).toMatch(/var\(--/)
    const all = ['', '-track', '-thumb', '-thumb:hover'].map((s) => ruleBody('.scroll-themed::-webkit-scrollbar' + s)).join('\n')
    expect(all, 'no hard-coded colour').not.toMatch(HARD_COLOUR)
  })

  test('does not hide the scrollbar', () => {
    expect(ruleBody('.scroll-themed')).not.toMatch(/scrollbar-width:\s*none|display:\s*none/)
  })
})

describe('navigation scroll areas use it', () => {
  test('the sidebar nav element carries the class', () => {
    expect(read('src/lib/components/layout/Sidebar.svelte')).toMatch(/<nav class="sb-nav scroll-themed"/)
  })
  test('the drawer panel carries the class', () => {
    expect(read('src/lib/components/layout/NavDrawer.svelte')).toMatch(/class="nav-drawer scroll-themed"/)
  })
})
