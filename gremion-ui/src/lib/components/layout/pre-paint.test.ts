import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { NAV_STORAGE_KEY } from './nav-constants'

/**
 * Executes app.html's inline pre-paint script in a fresh VM context with a fake
 * localStorage and document, and asserts the html classes it sets from
 * gremion.nav — the first paint must already have the navigation width.
 */
const APP_HTML = readFileSync(resolve(process.cwd(), 'src', 'app.html'), 'utf8')

function prePaintScript(): string {
  const scripts = [...APP_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const script = scripts.find((s) => s.includes('localStorage'))
  if (!script) throw new Error('no pre-paint <script> in app.html')
  return script
}

function run(stored: Record<string, string>, opts: { throwing?: boolean } = {}) {
  const data = new Map(Object.entries(stored))
  const writes: string[] = []
  const classes = new Set<string>()
  const localStorage = {
    getItem: (k: string) => {
      if (opts.throwing) throw new Error('SecurityError')
      return data.has(k) ? data.get(k)! : null
    },
    setItem: (k: string, v: string) => {
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
  test("'rail' sets html.nav-rail only", () => {
    const { classes } = run({ [NAV_STORAGE_KEY]: 'rail' })
    expect(classes.has('nav-rail')).toBe(true)
    expect(classes.has('nav-expanded')).toBe(false)
  })

  test("'expanded' sets html.nav-expanded only", () => {
    const { classes } = run({ [NAV_STORAGE_KEY]: 'expanded' })
    expect(classes.has('nav-expanded')).toBe(true)
    expect(classes.has('nav-rail')).toBe(false)
  })

  test.each([[{}], [{ [NAV_STORAGE_KEY]: 'drawer' }], [{ [NAV_STORAGE_KEY]: '' }]])(
    'nothing or an invalid value sets neither class (%j)',
    (stored) => {
      const { classes } = run(stored)
      expect(classes.has('nav-rail')).toBe(false)
      expect(classes.has('nav-expanded')).toBe(false)
    }
  )

  test('the script never writes gremion.nav', () => {
    expect(run({}).writes).not.toContain(NAV_STORAGE_KEY)
    expect(run({ [NAV_STORAGE_KEY]: 'rail' }).writes).not.toContain(NAV_STORAGE_KEY)
  })

  test('a throwing storage is swallowed (the page still renders)', () => {
    expect(() => run({}, { throwing: true })).not.toThrow()
  })

  test('the existing prefs still apply alongside (theme)', () => {
    const { classes } = run({ 'gremion.theme': 'dark', [NAV_STORAGE_KEY]: 'rail' })
    expect(classes.has('dark')).toBe(true)
    expect(classes.has('nav-rail')).toBe(true)
  })
})
