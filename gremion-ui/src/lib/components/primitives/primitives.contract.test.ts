// Cross-primitive contract (TASK-082 brief sections 1 and 6 items 5, 6, 8):
//  - axe-core on every rendered primitive, closed and open: 0 violations
//    (static role / name / ARIA rules; jsdom has no layout, so colour
//    contrast is out of scope here and belongs to TASK-109's browser pass);
//  - every accessible name and visible string comes from a prop: DE and EN
//    renders produce different names, and the sources hold no literal text;
//  - the styles read component-tier tokens only and set no font-size literal.
import { describe, test, expect, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { flatten, parseStrictJson } from '@gremion/tokens'

import Dialog from './Dialog.svelte'
import Select from './Select.svelte'
import Combobox from './Combobox.svelte'
import Menu from './Menu.svelte'
import { installDomShims } from './__tests__/dom-shims'

installDomShims()

beforeEach(() => {
  document.body.style.pointerEvents = ''
})

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
}

async function axeViolations(): Promise<string[]> {
  const res = await axe.run(document.body, AXE_OPTIONS)
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

const DE = {
  dialog: { title: 'Sitzung anlegen', closeLabel: 'Dialog schließen', triggerLabel: 'Neue Sitzung' },
  select: { label: 'Sitzungsart', placeholder: 'Bitte wählen' },
  combobox: { label: 'Referat', placeholder: 'Referat suchen', toggleLabel: 'Vorschläge anzeigen', emptyText: 'Keine Treffer' },
  menu: { triggerLabel: 'Aktionen' },
  options: [
    { value: 'a', label: 'Ordentliche Sitzung' },
    { value: 'b', label: 'Außerordentliche Sitzung' },
  ],
}
const EN = {
  dialog: { title: 'Create meeting', closeLabel: 'Close dialog', triggerLabel: 'New meeting' },
  select: { label: 'Meeting type', placeholder: 'Please choose' },
  combobox: { label: 'Office', placeholder: 'Search offices', toggleLabel: 'Show suggestions', emptyText: 'No matches' },
  menu: { triggerLabel: 'Actions' },
  options: [
    { value: 'a', label: 'Regular meeting' },
    { value: 'b', label: 'Extraordinary meeting' },
  ],
}
type Strings = typeof DE

const menuItems = (s: Strings) => s.options.map((o) => ({ id: o.value, label: o.label, onSelect: () => {} }))

describe('axe-core: 0 violations on every primitive, closed and open', () => {
  test('Dialog', async () => {
    const user = userEvent.setup()
    render(Dialog, { props: { ...DE.dialog, description: 'Termin festlegen' } })
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('button', { name: DE.dialog.triggerLabel }))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    expect(await axeViolations()).toEqual([])
  })

  test('Select', async () => {
    const user = userEvent.setup()
    render(Select, { props: { ...DE.select, options: DE.options, value: 'a' } })
    expect(await axeViolations()).toEqual([])
    screen.getByRole('combobox', { name: DE.select.label }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(await axeViolations()).toEqual([])
  })

  test('Combobox (with matches and with none)', async () => {
    const user = userEvent.setup()
    render(Combobox, { props: { ...DE.combobox, options: DE.options } })
    expect(await axeViolations()).toEqual([])
    await user.click(screen.getByRole('combobox', { name: DE.combobox.label }))
    await user.keyboard('sitz')
    await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy())
    expect(await axeViolations()).toEqual([])
    await user.keyboard('zzz')
    await waitFor(() => expect(screen.getByText(DE.combobox.emptyText)).toBeTruthy())
    expect(await axeViolations()).toEqual([])
  })

  test('Menu', async () => {
    const user = userEvent.setup()
    render(Menu, { props: { ...DE.menu, items: menuItems(DE) } })
    expect(await axeViolations()).toEqual([])
    screen.getByRole('button', { name: DE.menu.triggerLabel }).focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('menu')).toBeTruthy())
    expect(await axeViolations()).toEqual([])
  })
})

/** The accessible names each primitive exposes, rendered open, for one language. */
async function names(s: Strings): Promise<string[]> {
  const user = userEvent.setup()
  const out: string[] = []

  render(Dialog, { props: s.dialog })
  await user.click(screen.getByRole('button', { name: s.dialog.triggerLabel }))
  const dialog = await screen.findByRole('dialog')
  out.push(dialog.getAttribute('aria-labelledby') ? (document.getElementById(dialog.getAttribute('aria-labelledby') as string)?.textContent ?? '') : '')
  out.push(screen.getByRole('button', { name: s.dialog.closeLabel }).getAttribute('aria-label') ?? '')
  cleanup()
  document.body.style.pointerEvents = ''

  render(Select, { props: { ...s.select, options: s.options } })
  const sel = screen.getByRole('combobox', { name: s.select.label })
  out.push(document.getElementById(sel.getAttribute('aria-labelledby') as string)?.textContent ?? '')
  out.push(sel.textContent?.trim() ?? '')
  sel.focus()
  await user.keyboard('{Enter}')
  out.push(...(await screen.findAllByRole('option')).map((o) => o.textContent?.trim() ?? ''))
  cleanup()
  document.body.style.pointerEvents = ''

  render(Combobox, { props: { ...s.combobox, options: s.options } })
  const cb = screen.getByRole('combobox', { name: s.combobox.label })
  out.push(cb.getAttribute('placeholder') ?? '')
  out.push(screen.getByRole('button', { name: s.combobox.toggleLabel }).getAttribute('aria-label') ?? '')
  cleanup()

  render(Menu, { props: { ...s.menu, items: menuItems(s) } })
  const mb = screen.getByRole('button', { name: s.menu.triggerLabel })
  out.push(mb.textContent?.trim() ?? '')
  mb.focus()
  await user.keyboard('{Enter}')
  out.push(...(await screen.findAllByRole('menuitem')).map((o) => o.textContent?.trim() ?? ''))
  cleanup()
  document.body.style.pointerEvents = ''
  return out
}

describe('i18n: every accessible name and visible string is a prop', () => {
  test('DE and EN renders expose the given strings, and they differ', async () => {
    const de = await names(DE)
    const en = await names(EN)
    expect(de).toEqual([
      DE.dialog.title,
      DE.dialog.closeLabel,
      DE.select.label,
      DE.select.placeholder,
      ...DE.options.map((o) => o.label),
      DE.combobox.placeholder,
      DE.combobox.toggleLabel,
      DE.menu.triggerLabel,
      ...DE.options.map((o) => o.label),
    ])
    expect(en).toHaveLength(de.length)
    de.forEach((name, i) => expect(en[i], `name ${i}`).not.toBe(name))
  })

  test('no primitive source carries literal markup text or a literal aria-label/title/placeholder', () => {
    const offenders: string[] = []
    for (const f of sources('.svelte')) {
      const markup = stripNonMarkup(f.text)
      const literalAttr = /\s(aria-label|aria-description|title|placeholder|alt)="[^"{]*[A-Za-zÄÖÜäöüß][^"]*"/g
      for (const m of markup.matchAll(literalAttr)) offenders.push(`${f.name}: ${m[0].trim()}`)
      const text = markup
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .trim()
      if (/[A-Za-zÄÖÜäöüß]/.test(text)) offenders.push(`${f.name}: literal text "${text.slice(0, 60)}"`)
    }
    expect(offenders).toEqual([])
  })
})

const HERE = __dirname
function sources(ext: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const name of readdirSync(HERE)) {
    if (name.endsWith(ext)) out.push({ name, text: readFileSync(join(HERE, name), 'utf8') })
  }
  if (out.length === 0) throw new Error(`no ${ext} sources in primitives/ -- a vacuous pass`)
  return out
}
function stripNonMarkup(svelte: string): string {
  return svelte
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}
function styleText(): string {
  const svelte = sources('.svelte').map((f) => (f.text.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n'))
  const css = sources('.css').map((f) => f.text)
  return [...svelte, ...css].join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('tokens: the primitives read the component tier only', () => {
  test('every var(--x) in primitives styles is a component-tier token (or a Bits UI runtime --bits-* variable)', () => {
    // Read from the repo path: under jsdom import.meta.url is not a file: URL,
    // so the package's own loader cannot locate its JSON here.
    const tokenFile = join(HERE, '..', '..', '..', '..', '..', 'packages', 'tokens', 'tokens', 'gremion.tokens.json')
    const base = parseStrictJson(readFileSync(tokenFile, 'utf8'), tokenFile) as Record<string, unknown>
    const component = new Set<string>()
    for (const t of flatten(base).values()) {
      if (!t.path.startsWith('component.') || !t.ext.css) continue
      component.add(t.ext.css)
      if (t.type === 'typography') component.add(`${t.ext.css}-tracking`)
    }
    expect(component.size).toBeGreaterThan(20)
    const used = [...styleText().matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(20)
    const foreign = [...new Set(used)].filter((v) => !component.has(v) && !v.startsWith('--bits-'))
    expect(foreign).toEqual([])
  })

  test('no font-size literal (or font-size at all) in primitives: type comes from the type-scale tokens', () => {
    const css = styleText()
    expect(css).not.toMatch(/font-size\s*:/)
    const fonts = [...css.matchAll(/(?:^|[;{\s])font\s*:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) expect(f).toMatch(/^(var\(--[a-z0-9-]+\)|inherit)$/)
    for (const f of sources('.svelte')) {
      expect(stripNonMarkup(f.text), f.name).not.toMatch(/class="[^"]*\btext-(xs|sm|base|lg|xl|\dxl)\b/)
    }
  })
})
