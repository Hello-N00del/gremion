// @vitest-environment node
//
// Every routed page has a browser title and a named section in the top bar.
//
// The walk reads the page sources where they are kept: the kernel pages under
// gremion-ui/src/routes and each module's pages under modules/<id>/app/routes
// (the copies the module overlay places under src/routes are the same files and
// are skipped). A page passes when it
//   - renders <PageTitle>, a <title> of its own, or a component that does, and
//   - has a German name in CRUMB_LABELS for every route folder on its path, and
//   - shows no route parameter (an id) as a section name unless it names it.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CRUMB_LABELS, crumbsFor } from '$lib/components/layout/crumbs'

const HERE = dirname(fileURLToPath(import.meta.url))
const KERNEL_ROUTES = HERE
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const MODULES_DIR = join(REPO_ROOT, 'modules')

const posix = (p: string) => p.split(sep).join('/')

function pagesUnder(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) pagesUnder(abs, base, out)
    else if (name === '+page.svelte') out.push(posix(relative(base, abs)))
  }
  return out
}

interface RoutedPage {
  /** SvelteKit route id, e.g. '/polls/[id]'. */
  route: string
  /** Repo-relative source file. */
  file: string
  source: string
}

function collect(): RoutedPage[] {
  const pages = new Map<string, RoutedPage>()
  const add = (routesDir: string) => {
    for (const rel of pagesUnder(routesDir)) {
      const route = '/' + rel.replace(/\/?\+page\.svelte$/, '')
      const abs = join(routesDir, rel)
      pages.set(route === '/' ? '/' : route, {
        route,
        file: posix(relative(REPO_ROOT, abs)),
        source: readFileSync(abs, 'utf8'),
      })
    }
  }
  add(KERNEL_ROUTES)
  // Module sources win over their overlay copies under src/routes.
  for (const id of readdirSync(MODULES_DIR)) {
    const routesDir = join(MODULES_DIR, id, 'app', 'routes')
    if (existsSync(routesDir)) add(routesDir)
  }
  return [...pages.values()].sort((a, b) => a.route.localeCompare(b.route))
}

const PAGES = collect()

// Components that render <PageTitle> for the page that uses them.
const TITLE_CARRIERS: Record<string, string> = {
  LegalDoc: 'gremion-ui/src/lib/components/legal/LegalDoc.svelte',
}

/** Pages that are never shown to a person, with the reason. */
const NO_TITLE: Record<string, string> = {
  '/auth/logout': 'never rendered: the server action always redirects',
  '/elections/[id]/helios-cb': 'blank callback page, loaded in a hidden frame or redirected at once',
}

/** Routes outside the app shell: they have no top bar, so no section name. */
const NO_SHELL = [/^\/auth(\/|$)/, /^\/legal(\/|$)/]

function hasTitleSource(source: string): boolean {
  if (/<PageTitle[\s/>]/.test(source)) return true
  if (/<svelte:head>[\s\S]*?<title[\s>]/.test(source)) return true
  return Object.keys(TITLE_CARRIERS).some((name) => new RegExp(`<${name}[\\s/>]`).test(source))
}

describe('every routed page has a title source', () => {
  it('walks the real route tree (kernel and modules), not an empty one', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(45)
    const routes = PAGES.map((p) => p.route)
    expect(routes).toContain('/')
    expect(routes).toContain('/members/committees/[id]')
    expect(routes).toContain('/members/committees/[id]/protokolle/[protocolId]')
    expect(routes).toContain('/polls/[id]')
    expect(PAGES.some((p) => p.file.startsWith('modules/'))).toBe(true)
    expect(PAGES.some((p) => p.file.startsWith('gremion-ui/src/routes/'))).toBe(true)
  })

  it('the components trusted to carry a title still render one', () => {
    for (const [name, file] of Object.entries(TITLE_CARRIERS)) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8'), `${name} no longer renders <PageTitle>`).toMatch(
        /<PageTitle[\s/>]/,
      )
    }
  })

  it('no page is without a browser title', () => {
    const untitled = PAGES.filter((p) => !(p.route in NO_TITLE) && !hasTitleSource(p.source)).map((p) => p.file)
    expect(
      untitled,
      'These pages set no browser title. Render <PageTitle title="…" /> ($lib/components/PageTitle.svelte).',
    ).toEqual([])
  })

  it('the exemptions name real pages that indeed have no title', () => {
    for (const route of Object.keys(NO_TITLE)) {
      const page = PAGES.find((p) => p.route === route)
      expect(page, `${route} is exempted but is not a routed page`).toBeDefined()
      expect(hasTitleSource(page!.source), `${route} has a title now: drop its exemption`).toBe(false)
    }
  })
})

describe('every routed page has a named section in the top bar', () => {
  const inShell = PAGES.filter((p) => !(p.route in NO_TITLE) && !NO_SHELL.some((re) => re.test(p.route)))

  it('covers the shell pages', () => {
    expect(inShell.length).toBeGreaterThanOrEqual(40)
  })

  it('every route folder has a German name', () => {
    const unnamed = new Map<string, string>()
    for (const page of inShell) {
      for (const segment of page.route.split('/').filter(Boolean)) {
        if (segment.startsWith('[')) continue
        if (!Object.hasOwn(CRUMB_LABELS, segment)) unnamed.set(segment, page.route)
      }
    }
    expect(
      [...unnamed].map(([segment, route]) => `${segment} (${route})`),
      'These route folders would show their raw name in the top bar. Add them to CRUMB_LABELS (crumbs.ts).',
    ).toEqual([])
  })

  it('no page shows a route parameter (an id) as its section name', () => {
    const leaks: string[] = []
    for (const page of inShell) {
      const params: Record<string, string> = {}
      const pathname = page.route.replace(/\[(\.\.\.)?([^\]=]+)(?:=[^\]]+)?\]/g, (_m, rest: string | undefined, name: string) => {
        if (rest) {
          params[name] = 'Ordner'
          return 'Ordner'
        }
        params[name] = `raw-id-${name}`
        return params[name]
      })
      const crumbs = crumbsFor({ pathname, routeId: page.route, params })
      if (crumbs.some((c) => c.startsWith('raw-id-'))) leaks.push(`${page.route} -> ${crumbs.join(' / ')}`)
      if (crumbs.length === 0 && page.route !== '/') leaks.push(`${page.route} -> no section name at all`)
    }
    expect(leaks).toEqual([])
  })
})
