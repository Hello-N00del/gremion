import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { NAV_STORAGE_KEY, NAV_CLASS_RAIL as RAIL, NAV_CLASS_EXPANDED as EXPANDED } from './nav-constants'

/**
 * Executes app.html's inline pre-paint script in a fresh VM context with a fake
 * localStorage and document, and asserts the html classes it sets from
 * gremion.nav — the first paint must already have the navigation width.
 */
const APP_HTML = readFileSync(resolve(process.cwd(), 'src', 'app.html'), 'utf8')

function prePaintScript(): string {
  // Nonce-tolerant: under the nonce-based CSP the tag is <script nonce="%sveltekit.nonce%">.
  const scripts = [...APP_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const script = scripts.find((s) => s.includes('localStorage'))
  if (!script) throw new Error('no pre-paint <script> in app.html')
  return script
}

function run(stored: Record<string, string>, opts: { throwing?: boolean; writeThrows?: boolean } = {}) {
  const data = new Map(Object.entries(stored))
  const writes: string[] = []
  const classes = new Set<string>()
  const localStorage = {
    getItem: (k: string) => {
      if (opts.throwing) throw new Error('SecurityError')
      return data.has(k) ? data.get(k)! : null
    },
    setItem: (k: string, v: string) => {
      if (opts.writeThrows) throw new Error('QuotaExceededError')
      writes.push(k)
      data.set(k, v)
    },
    removeItem: (k: string) => void data.delete(k)
  }
  const documentElement = {
    lang: '',
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      contains: (c: string) => classes.has(c)
    }
  }
  runInNewContext(prePaintScript(), { localStorage, document: { documentElement } })
  return { classes, writes }
}

describe('app.html pre-paint: gremion.nav', () => {
  test('the script is inline in <head>, before %sveltekit.head% and the body', () => {
    const at = APP_HTML.indexOf(prePaintScript())
    expect(at).toBeGreaterThan(APP_HTML.indexOf('<head>'))
    expect(at).toBeLessThan(APP_HTML.indexOf('%sveltekit.head%'))
    expect(at).toBeLessThan(APP_HTML.indexOf('<body'))
  })

  test("'rail' sets html.nav-rail only", () => {
    const { classes } = run({ [NAV_STORAGE_KEY]: 'rail' })
    expect(classes.has(RAIL)).toBe(true)
    expect(classes.has(EXPANDED)).toBe(false)
  })

  test("'expanded' sets html.nav-expanded only", () => {
    const { classes } = run({ [NAV_STORAGE_KEY]: 'expanded' })
    expect(classes.has(EXPANDED)).toBe(true)
    expect(classes.has(RAIL)).toBe(false)
  })

  test.each([[{}], [{ [NAV_STORAGE_KEY]: 'drawer' }], [{ [NAV_STORAGE_KEY]: '' }]])(
    'nothing or an invalid value sets neither class (%j)',
    (stored) => {
      const { classes } = run(stored)
      expect(classes.has(RAIL)).toBe(false)
      expect(classes.has(EXPANDED)).toBe(false)
    }
  )

  test('the script never writes gremion.nav', () => {
    expect(run({}).writes).not.toContain(NAV_STORAGE_KEY)
    expect(run({ [NAV_STORAGE_KEY]: 'rail' }).writes).not.toContain(NAV_STORAGE_KEY)
  })

  test('a throwing storage is swallowed (the page still renders)', () => {
    expect(() => run({}, { throwing: true })).not.toThrow()
  })

  test('a failing legacy-key migration does not skip the nav class', () => {
    const { classes } = run({ 'stura-theme': 'dark', [NAV_STORAGE_KEY]: 'rail' }, { writeThrows: true })
    expect(classes.has(RAIL)).toBe(true)
  })

  test('the existing prefs still apply alongside (theme)', () => {
    const { classes } = run({ 'gremion.theme': 'dark', [NAV_STORAGE_KEY]: 'rail' })
    expect(classes.has('dark')).toBe(true)
    expect(classes.has(RAIL)).toBe(true)
  })
})
