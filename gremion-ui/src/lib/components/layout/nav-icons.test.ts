import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { baseNavSchema, composeNavSchema, type NavItem, type NavTemplateEntry } from './nav-schema'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import { NAV_FIXTURE_MANIFEST } from './fixtures/nav-fixture-manifest'
import { iconNamesFromSource, navIconNames, missingNavIcons, duplicateNavIcons } from './nav-icons'

/**
 * Icon.svelte silently draws a 2 px dot for an unknown name, so a typo in a nav
 * icon ships an invisible rail entry. This guard resolves every nav icon of the
 * base schema and of every registered manifest (plus the fixture manifest
 * until real module manifests carry nav) against the icon map.
 */
const ICON_SOURCE = readFileSync(resolve(process.cwd(), 'src/lib/components/ui/Icon.svelte'), 'utf8')
const KNOWN = iconNamesFromSource(ICON_SOURCE)

const templateItems = (entries: NavTemplateEntry[]): NavItem[] =>
  entries.flatMap((e) => ('slot' in e ? [] : e.kind === 'section' ? templateItems(e.children) : [e]))

const manifests = [...MODULE_MANIFESTS, NAV_FIXTURE_MANIFEST]

describe('nav icon map', () => {
  test('the parser finds the icon map (sanity: a non-trivial set incl. home)', () => {
    expect(KNOWN.size).toBeGreaterThan(40)
    expect(KNOWN.has('home')).toBe(true)
  })

  test('the shell controls have their glyphs (menu, sidebar, x)', () => {
    for (const n of ['menu', 'sidebar', 'x']) expect(KNOWN.has(n), n).toBe(true)
  })

  test('every base-schema nav icon resolves', () => {
    const names = navIconNames(templateItems(baseNavSchema))
    expect(names.length).toBeGreaterThan(5)
    expect(missingNavIcons(templateItems(baseNavSchema), KNOWN)).toEqual([])
  })

  test('every registered manifest nav icon resolves, and at least one manifest nav item is checked', () => {
    const items = manifests.flatMap((m) => m.nav ?? [])
    expect(navIconNames(items).length).toBeGreaterThanOrEqual(1)
    expect(missingNavIcons(items, KNOWN)).toEqual([])
  })

  test('the composed rail (base + manifests) has no two items sharing a glyph', () => {
    const composed = composeNavSchema(baseNavSchema, manifests)
    const all = [...composed, ...(NAV_FIXTURE_MANIFEST.nav ?? [])]
    expect(duplicateNavIcons(all)).toEqual([])
  })

  test('the guard itself catches an unknown name and a shared glyph', () => {
    const seeded: NavItem[] = [
      { kind: 'item', href: '/a', label: 'A', icon: 'home' },
      { kind: 'item', href: '/b', label: 'B', icon: 'no-such-glyph' },
      { kind: 'item', href: '/c', label: 'C', icon: 'home' }
    ]
    expect(missingNavIcons(seeded, KNOWN)).toEqual(['no-such-glyph (/b)'])
    expect(duplicateNavIcons(seeded)).toEqual(['home: /a, /c'])
  })

  test('a nav item without an icon does not type-check', () => {
    // @ts-expect-error — NavItem items require icon (TASK-208)
    const bad: NavItem = { kind: 'item', href: '/x', label: 'X' }
    expect(bad.kind).toBe('item')
  })

  test('the parser finds the icon map on a CRLF checkout (core.autocrlf=true)', () => {
    const crlfSource = ICON_SOURCE.includes('\r\n') ? ICON_SOURCE : ICON_SOURCE.replace(/\n/g, '\r\n')
    const namesFromCrlf = iconNamesFromSource(crlfSource)
    expect(namesFromCrlf.size).toBeGreaterThan(40)
    expect(namesFromCrlf.has('home')).toBe(true)
    expect(namesFromCrlf).toEqual(KNOWN)
  })
})
