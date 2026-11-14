// @vitest-environment node
//
// Every checkbox names itself.
//
// A checkbox that only sits inside a <label> (or beside a <span>) has no name of
// its own: a screen reader on a browser or tool that does not work the wrapping
// label out announces it as "on", the default value of a checkbox. The e2e
// walk-through heard "on" for the content channels, the calendar committees and
// the minutes' action items. Each <input type="checkbox"> therefore carries
// aria-label, aria-labelledby, or an id that a <label for> points at.
//
// The walk reads the sources where they live: the kernel under gremion-ui/src and
// each module's pages and components under modules/<id>/app (the overlay copies
// the modules produce under gremion-ui/src are the same files and are skipped).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_SRC = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(UI_SRC, '..', '..')
const MODULES_DIR = join(REPO_ROOT, 'modules')

const posix = (p: string) => p.split(sep).join('/')

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) svelteFiles(abs, out)
    else if (name.endsWith('.svelte')) out.push(abs)
  }
  return out
}

/** Every `<input …>` start tag, attribute expressions in braces and quotes respected. */
export function inputTags(source: string): { tag: string; line: number }[] {
  const tags: { tag: string; line: number }[] = []
  const open = /<input\b/g
  for (let m = open.exec(source); m; m = open.exec(source)) {
    let depth = 0
    let quote: string | null = null
    let end = -1
    for (let i = m.index + m[0].length; i < source.length; i++) {
      const c = source[i]
      if (quote) {
        if (c === quote) quote = null
      } else if (depth > 0) {
        if (c === '{') depth++
        else if (c === '}') depth--
        else if (c === '"' || c === "'" || c === '`') quote = c
      } else if (c === '{') depth++
      else if (c === '"' || c === "'") quote = c
      else if (c === '>') {
        end = i
        break
      }
    }
    if (end < 0) continue
    tags.push({ tag: source.slice(m.index, end + 1), line: source.slice(0, m.index).split('\n').length })
  }
  return tags
}

const isCheckbox = (tag: string) => /\btype=(["'])checkbox\1/.test(tag)
const hasOwnName = (tag: string) => /\saria-label(ledby)?=/.test(tag) || /\sid=/.test(tag)

function sources(): { file: string; source: string }[] {
  const files = new Map<string, string>()
  for (const abs of svelteFiles(UI_SRC)) files.set(posix(relative(REPO_ROOT, abs)), abs)
  if (existsSync(MODULES_DIR)) {
    for (const id of readdirSync(MODULES_DIR)) {
      const appDir = join(MODULES_DIR, id, 'app')
      if (existsSync(appDir)) for (const abs of svelteFiles(appDir)) {
          // The module's copy wins over the overlay copy it produces under gremion-ui/src.
          files.delete('gremion-ui/src/' + posix(relative(appDir, abs)))
          files.set(posix(relative(REPO_ROOT, abs)), abs)
        }
    }
  }
  return [...files].map(([file, abs]) => ({ file, source: readFileSync(abs, 'utf8') }))
}

describe('inputTags (the scanner behind the walk)', () => {
  it('reads a tag whose attribute expressions contain > and quotes', () => {
    const src = `<div>\n<input\n  type="checkbox"\n  onchange={(e) => set(e.currentTarget.checked ? '>' : "<")}\n  aria-label="Ja"\n/>\n</div>`
    const tags = inputTags(src)
    expect(tags).toHaveLength(1)
    expect(tags[0]!.line).toBe(2)
    expect(isCheckbox(tags[0]!.tag)).toBe(true)
    expect(hasOwnName(tags[0]!.tag)).toBe(true)
  })

  it('tells a nameless checkbox from a named one', () => {
    expect(hasOwnName('<input type="checkbox" checked />')).toBe(false)
    expect(hasOwnName('<input type="checkbox" id="x" />')).toBe(true)
    expect(hasOwnName('<input type="checkbox" aria-labelledby="h" />')).toBe(true)
  })
})

describe('every checkbox names itself', () => {
  const all = sources()

  it('walks the real source tree, not an empty one', () => {
    expect(all.length).toBeGreaterThan(100)
    const checkboxes = all.flatMap((s) => inputTags(s.source).filter((t) => isCheckbox(t.tag)))
    expect(checkboxes.length).toBeGreaterThanOrEqual(10)
  })

  it('no <input type="checkbox"> is left to be announced as "on"', () => {
    const nameless: string[] = []
    for (const { file, source } of all) {
      for (const { tag, line } of inputTags(source)) {
        if (isCheckbox(tag) && !hasOwnName(tag)) nameless.push(`${file}:${line}`)
      }
    }
    expect(
      nameless,
      'These checkboxes have no aria-label, aria-labelledby or id. Add aria-label="<what it switches>".',
    ).toEqual([])
  })
})
