// TASK-205a TDD 3 (offline half): every ENABLED module's landing route is wired into the kernel build.
//
// The e2e spec (tests/e2e/module-landing-routes.spec.ts) proves a landing route is SERVED; this proves, on
// the working tree after the interim overlay, the three links that make it servable: the page file exists
// under src/routes (the overlay put it there), the module's manifest is in the registered set (so its
// segment is in PAGE_ACCESS and its prefixes gate it), and the image build copies the module's app/ half
// before `pnpm build`. Remove one module's wiring and its case goes red.
//
// The module set is read from the repository (modules/*/app, modules/disabled.json), never restated.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PAGE_ACCESS } from '$lib/auth'
import { MODULE_MANIFESTS } from '$lib/modules/registry'

const UI_ROOT = resolve(process.cwd())
const REPO_ROOT = resolve(UI_ROOT, '..')
const MODULES_DIR = join(REPO_ROOT, 'modules')

const disabled: string[] = existsSync(join(MODULES_DIR, 'disabled.json'))
  ? (JSON.parse(readFileSync(join(MODULES_DIR, 'disabled.json'), 'utf8')).disabled ?? []).map((e: { id: string }) => e.id)
  : []

interface Landing {
  id: string
  segments: string[]
}

function enabledLandings(): Landing[] {
  const out: Landing[] = []
  for (const d of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!d.isDirectory() || disabled.includes(d.name)) continue
    const manifests = join(MODULES_DIR, d.name, 'app', 'lib', 'modules', 'manifests')
    if (!existsSync(manifests)) continue
    const segments = new Set<string>()
    for (const f of readdirSync(manifests)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      for (const m of readFileSync(join(manifests, f), 'utf8').matchAll(/segment:\s*'([^']+)'/g)) segments.add(m[1])
    }
    out.push({ id: d.name, segments: [...segments].sort() })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

const LANDINGS = enabledLandings()
const dockerfile = readFileSync(join(UI_ROOT, 'Dockerfile'), 'utf8')

describe('module landing wiring (TASK-205a)', () => {
  it('finds at least one enabled module with a landing segment (a vacuous set fails)', () => {
    expect(LANDINGS.length).toBeGreaterThan(0)
    for (const l of LANDINGS) expect(l.segments.length, `module ${l.id} declares no page segment`).toBeGreaterThan(0)
  })

  for (const l of LANDINGS) {
    describe(`enabled module ${l.id}`, () => {
      for (const segment of l.segments) {
        it(`/${segment}: a page file is in the build tree, the segment is in PAGE_ACCESS`, () => {
          const dir = join(UI_ROOT, 'src', 'routes', segment)
          const hasPage = ['+page.svelte', '+page.server.ts', '+page.ts', '+server.ts'].some((f) => existsSync(join(dir, f)))
          expect(hasPage, `src/routes/${segment} has no page: run node scripts/interim-module-overlay.mjs (modules/${l.id}/app is overlaid there)`).toBe(true)
          expect(Object.keys(PAGE_ACCESS), `PAGE_ACCESS lacks /${segment} (the module manifest is not in the generated barrel)`).toContain(segment)
        })
      }
      it('its manifest is registered and its half is copied into the image before pnpm build', () => {
        expect(MODULE_MANIFESTS.some((m) => m.pages.some((p) => l.segments.includes(p.segment))), `no registered manifest serves ${l.segments.join(', ')}`).toBe(true)
        const buildAt = dockerfile.indexOf('RUN pnpm build')
        expect(dockerfile.slice(0, buildAt), `Dockerfile lacks COPY modules/${l.id}/app before pnpm build`).toContain(`COPY modules/${l.id}/app ./modules/${l.id}/app/`)
      })
    })
  }

  it('a disabled module contributes no page file and no registered manifest', () => {
    for (const id of disabled) {
      const manifests = join(MODULES_DIR, id, 'app', 'lib', 'modules', 'manifests')
      if (!existsSync(manifests)) continue
      for (const f of readdirSync(manifests)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
        for (const m of readFileSync(join(manifests, f), 'utf8').matchAll(/segment:\s*'([^']+)'/g)) {
          const isKernelSegment = ['dashboard', 'settings', 'systemstatus', 'members', 'committees', 'portal', 'protokolle', 'beschluesse'].includes(m[1])
          if (isKernelSegment) continue
          expect(existsSync(join(UI_ROOT, 'src', 'routes', m[1], '+page.svelte')), `disabled module ${id}: /${m[1]} must not be routable`).toBe(false)
          expect(Object.keys(PAGE_ACCESS), `disabled module ${id}: /${m[1]} must not be in PAGE_ACCESS`).not.toContain(m[1])
        }
      }
    }
  })
})
