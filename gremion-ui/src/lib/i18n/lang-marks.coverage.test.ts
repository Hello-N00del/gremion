// @vitest-environment node
//
// locale-en unit, WCAG 3.1.2 (Language of Parts): mechanical coverage guard.
//
// A page declared German (<html lang="de">, content-locale.ts) still renders every catalogue string in
// the person's locale. Each such string has to sit under an element that names its language, otherwise
// an English reading is announced with German pronunciation. The render guards (settings, +error,
// ModuleOffWarning, ...) each render a hand-listed component, so a page nobody listed was never checked.
// This one is not listed: it scans EVERY .svelte file under src/ (the module overlay copies included) and
// fails for any markup call to the catalogue (`$t(...)`) that has no lang-bearing element above it in its
// own file, unless the file is named below with the reason its marks come from somewhere else.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse } from 'svelte/compiler'
import { isTranslatedRoute } from './content-locale'

const SRC = join(__dirname, '..', '..')

type AstNode = { type?: string; start?: number; [key: string]: unknown }

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

const isElement = (n: AstNode) => n.type === 'RegularElement' || n.type === 'SvelteElement'
/**
 * Components that apply their `lang` prop to the container of everything inside them (the dialog primitive),
 * so `<Dialog lang={$lang}>` marks its children like an element would.
 */
const MARKING_COMPONENTS: ReadonlySet<string> = new Set(['Dialog'])
/**
 * Components that take catalogue text as a prop and mark it themselves where they render it. The guard
 * proves the claim below: every catalogue reference in each one's own file is under a lang mark.
 */
const SELF_MARKING_COMPONENTS: Readonly<Record<string, string>> = { RetainedRecords: 'lib/components/RetainedRecords.svelte' }
/**
 * The document <title> (PageTitle): an element of <head> that cannot be marked and that no screen reader
 * announces by element language, so a catalogue title is not a lang gap.
 */
const DOCUMENT_TITLE_COMPONENTS: ReadonlySet<string> = new Set(['PageTitle'])

const hasLangAttribute = (n: AstNode) =>
  (isElement(n) || (n.type === 'Component' && MARKING_COMPONENTS.has(String(n.name)))) &&
  (n.attributes as AstNode[]).some((a) => a.type === 'Attribute' && a.name === 'lang')
// Any reference to the `$t` store counts, not only a call: `fmtMeetingPill(start, $t)` hands it on.
const isCatalogueCall = (n: AstNode) => n.type === 'Identifier' && n.name === '$t'

/** Offsets of the markup `$t(...)` calls that have no lang-bearing element above them in the same file. */
export function unmarkedMarkupCalls(source: string): { total: number; unmarked: number[] } {
  const ast = parse(source, { modern: true }) as unknown as { fragment: AstNode }
  let total = 0
  const unmarked: number[] = []
  const walk = (node: unknown, marked: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, marked)
      return
    }
    if (!node || typeof node !== 'object') return
    const n = node as AstNode
    if (isElement(n) && (n.name === 'script' || n.name === 'style')) return
    // A catalogue string handed to a component that marks it itself, or to the document title.
    if (n.type === 'Component' && (String(n.name) in SELF_MARKING_COMPONENTS || DOCUMENT_TITLE_COMPONENTS.has(String(n.name)))) {
      walk(n.fragment, marked)
      return
    }
    const here = marked || hasLangAttribute(n)
    if (isCatalogueCall(n)) {
      total++
      if (!here) unmarked.push(n.start ?? -1)
    }
    for (const [key, value] of Object.entries(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'metadata') continue
      if (value && typeof value === 'object') walk(value, here)
    }
  }
  walk(ast.fragment, false)
  return { total, unmarked }
}

/**
 * A `$t` that is only read in the script (a label computed there, shown later as `{label}`) cannot be
 * followed to the element that renders it. The file is then required to carry some lang mark in its markup;
 * the settings, error and dialog render tests judge the rest.
 */
export function scriptOnlyWithoutMarks(source: string): boolean {
  const ast = parse(source, { modern: true }) as unknown as { fragment: AstNode; instance?: AstNode; module?: AstNode }
  let inScript = 0
  let hasMark = false
  const walk = (node: unknown, script: boolean): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, script)
      return
    }
    if (!node || typeof node !== 'object') return
    const n = node as AstNode
    if (script && isCatalogueCall(n)) inScript++
    if (!script && hasLangAttribute(n)) hasMark = true
    for (const [key, value] of Object.entries(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'metadata') continue
      if (value && typeof value === 'object') walk(value, script)
    }
  }
  walk(ast.fragment, false)
  walk(ast.instance, true)
  walk(ast.module, true)
  return inScript > 0 && !hasMark
}

/**
 * Pages declared in the person's locale (content-locale.ts TRANSLATED_ROUTE_IDS): there the page's own
 * language IS the person's, so catalogue text needs no mark of its own. Each entry names its route; the
 * guard checks the route is still on that list, and that the file really has unmarked references (so a
 * page that later gets marks, or leaves the list, fails here until this table follows).
 */
const DECLARED_IN_PERSONS_LOCALE: Readonly<Record<string, string>> = { 'routes/auth/login/+page.svelte': '/auth/login' }

const lineOf = (source: string, offset: number) => source.slice(0, offset).split('\n').length

describe('the probe', () => {
  it('flags a catalogue call with no lang above it, accepts one under a lang element, ignores script', () => {
    expect(unmarkedMarkupCalls('<p>{$t("a.b")}</p>').unmarked).toHaveLength(1)
    expect(unmarkedMarkupCalls('<p lang={$lang}>{$t("a.b")}</p>').unmarked).toHaveLength(0)
    expect(unmarkedMarkupCalls('<div lang={$lang}><Button label={$t("a.b")} /></div>').unmarked).toHaveLength(0)
    expect(unmarkedMarkupCalls('<div lang={$lang}></div><p aria-label={$t("a.b")}>x</p>').unmarked).toHaveLength(1)
    expect(unmarkedMarkupCalls('<p lang="en" aria-label={$t("a.b")}>x</p>').unmarked).toHaveLength(0)
    expect(unmarkedMarkupCalls('<Dialog lang={$lang}>{$t("a.b")}</Dialog>').unmarked).toHaveLength(0)
    expect(unmarkedMarkupCalls('<Dialog>{$t("a.b")}</Dialog>').unmarked).toHaveLength(1)
    expect(unmarkedMarkupCalls('<Card lang={$lang}>{$t("a.b")}</Card>').unmarked).toHaveLength(1)
    expect(unmarkedMarkupCalls('<RetainedRecords label={$t("a.b")} />').unmarked).toHaveLength(0)
    expect(unmarkedMarkupCalls('<PageTitle title={$t("a.b")} />').unmarked).toHaveLength(0)
    expect(unmarkedMarkupCalls('<Other title={$t("a.b")} />').unmarked).toHaveLength(1)
    expect(unmarkedMarkupCalls('<p>{fmt(start, $t)}</p>').unmarked).toHaveLength(1)
    expect(unmarkedMarkupCalls('<p lang={$lang}>{fmt(start, $t)}</p>').unmarked).toHaveLength(0)
    expect(scriptOnlyWithoutMarks('<script>const a = $t("x")</script><p>{a}</p>')).toBe(true)
    expect(scriptOnlyWithoutMarks('<script>const a = $t("x")</script><p lang={$lang}>{a}</p>')).toBe(false)
    expect(unmarkedMarkupCalls('<script>const a = $t("x")</script><p>x</p>').total).toBe(0)
    expect(unmarkedMarkupCalls('{#each xs as x}<li>{#if x}<b>{$t("a")}</b>{/if}</li>{/each}').unmarked).toHaveLength(1)
  })
})

describe('every markup catalogue call sits under a lang element (guard over all .svelte files)', () => {
  const files = filesUnder(SRC).filter((f) => f.endsWith('.svelte'))
  const rel = (f: string) => relative(SRC, f).split(sep).join('/')

  it('scans the shell, the routes and the module overlay', () => {
    const names = files.map(rel)
    expect(names).toContain('lib/components/layout/AppShell.svelte')
    expect(names.some((n) => n.startsWith('routes/files/'))).toBe(true)
    expect(files.length).toBeGreaterThan(100)
  })

  it('no file renders catalogue text without a lang mark above it', () => {
    const failures: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('$t')) continue
      const name = rel(file)
      if (name in DECLARED_IN_PERSONS_LOCALE) continue
      for (const offset of unmarkedMarkupCalls(source).unmarked) failures.push(`${name}:${lineOf(source, offset)}`)
      if (scriptOnlyWithoutMarks(source)) failures.push(`${name}: reads the catalogue in its script and marks nothing in its markup`)
    }
    expect(failures, 'mark the element with lang={$lang} (WCAG 3.1.2), or declare the page in the persons locale').toEqual([])
  })

  it('a page exempted as declared in the persons locale still is, and still needs the exemption', () => {
    for (const [name, routeId] of Object.entries(DECLARED_IN_PERSONS_LOCALE)) {
      expect(isTranslatedRoute(routeId), `${routeId} is in TRANSLATED_ROUTE_IDS`).toBe(true)
      const file = files.find((f) => rel(f) === name)
      expect(file, `${name} exists`).toBeDefined()
      expect(unmarkedMarkupCalls(readFileSync(file!, 'utf8')).unmarked.length, `${name} has unmarked references`).toBeGreaterThan(0)
    }
  })

  it('a self-marking component really marks every catalogue reference in its own file', () => {
    for (const [component, name] of Object.entries(SELF_MARKING_COMPONENTS)) {
      const file = files.find((f) => rel(f) === name)
      expect(file, `${component}: ${name} exists`).toBeDefined()
      const { total, unmarked } = unmarkedMarkupCalls(readFileSync(file!, 'utf8'))
      expect(total, `${component} renders catalogue text`).toBeGreaterThan(0)
      expect(unmarked, `${component} leaves references unmarked`).toEqual([])
    }
  })
})
