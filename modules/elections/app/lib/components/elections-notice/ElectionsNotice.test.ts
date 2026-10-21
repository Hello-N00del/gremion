// PRD-ELE-002: the permanent elections scope notice. Three claims (no statutory
// election, optional, off by default), no dismiss control, the same text for
// member and admin, and every page under /elections sits below the one mount.
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ElectionsNotice from './ElectionsNotice.svelte'
import Layout from '../../../routes/elections/+layout.svelte'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROUTES = join(HERE, '..', '..', '..', 'routes', 'elections')
const child = createRawSnippet(() => ({ render: () => '<p data-testid="child">page</p>' }))

afterEach(() => cleanup())

function pages(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) pages(full, out)
    else if (e.startsWith('+page')) out.push(full)
  }
  return out
}

describe('ElectionsNotice', () => {
  test('renders the three claims', () => {
    const { container } = render(ElectionsNotice)
    const text = container.textContent ?? ''
    expect(text).toContain('keine satzungsgemäßen Wahlen')
    expect(text).toContain('optional')
    expect(text).toContain('standardmäßig ausgeschaltet')
  })

  test('has no dismiss control of any kind', () => {
    const { container } = render(ElectionsNotice)
    expect(container.querySelectorAll('button, [role="button"], a, input, details, dialog')).toHaveLength(0)
    const src = readFileSync(join(HERE, 'ElectionsNotice.svelte'), 'utf8')
    expect(src).not.toMatch(/dismiss|onclick|localStorage|sessionStorage|\$state/i)
  })

  test('Du and Sie forms differ only in the follow-up sentence', () => {
    const du = render(ElectionsNotice, { address: 'du' }).container.textContent
    cleanup()
    const sie = render(ElectionsNotice, { address: 'sie' }).container.textContent
    expect(du).toContain('Schalte es')
    expect(sie).toContain('Schalten Sie es')
    expect(du).not.toEqual(sie)
  })
})

describe('elections layout mount', () => {
  test('the layout renders the notice above its children', () => {
    const { getByTestId } = render(Layout, { children: child })
    const notice = getByTestId('elections-notice')
    const kid = getByTestId('child')
    expect(notice.compareDocumentPosition(kid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('identical for member and admin: the layout reads no user, role or data', () => {
    const src = readFileSync(join(ROUTES, '+layout.svelte'), 'utf8')
    expect(src).not.toMatch(/\bdata\b|isAdmin|\brole\b|\buser\b|\bsession\b/)
    const a = render(Layout, { children: child }).container.innerHTML
    cleanup()
    const b = render(Layout, { children: child }).container.innerHTML
    expect(a).toEqual(b)
  })

  test('every +page.svelte under routes/elections sits below the layout and none resets it', () => {
    expect(existsSync(join(ROUTES, '+layout.svelte'))).toBe(true)
    const found = pages(ROUTES).filter((p) => p.endsWith('+page.svelte'))
    expect(found.length).toBeGreaterThanOrEqual(4)
    for (const p of found) {
      expect(p.startsWith(ROUTES)).toBe(true)
      expect(p).not.toMatch(/\+page@/)
    }
    // no nested layout may break out of the parent layout
    const all: string[] = []
    const walk = (d: string) => readdirSync(d).forEach((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : all.push(e)))
    walk(ROUTES)
    expect(all.filter((n) => /^\+layout@/.test(n) || /^\+page@/.test(n))).toEqual([])
  })
})
