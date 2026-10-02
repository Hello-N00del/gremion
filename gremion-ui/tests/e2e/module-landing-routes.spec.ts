/**
 * Module landing routes — signed-in spec (TASK-205a, post-condition 1; TASK-058 start-check).
 *
 * Every ENABLED module's landing route is served by the kernel build alone (the in-process halves reach the
 * build through the interim overlay, gremion-ui/scripts/interim-module-overlay.mjs): 200 and a main landmark
 * for a signed-in admin. Every DISABLED module's landing route is a 404 (its half is never overlaid, so the
 * route does not exist in the build).
 *
 * The module set is read from the repository, never restated here: a module directory with an app/ half is a
 * module, modules/disabled.json says which are off, and a module's landing segments are the `segment:` values
 * of its manifest(s) under modules/<id>/app/lib/modules/manifests. Adding a module therefore adds its test;
 * removing one module's wiring (its Dockerfile COPY, its overlay, its manifest) turns its landing test red.
 *
 * Reads E2E_BASE_URL, E2E_ADMIN_USER and E2E_ADMIN_PASS from the environment. A missing variable FAILS every
 * test, it never skips, so an unconfigured run cannot pass vacuously. Executed by TASK-209 on the test
 * environment; the unit counterpart (tests/unit/module-landing-wiring.test.ts) proves the same wiring offline.
 */
import { test, expect, type Page } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ENV_KEYS = ['E2E_BASE_URL', 'E2E_ADMIN_USER', 'E2E_ADMIN_PASS'] as const
const missingEnv = ENV_KEYS.filter((k) => !process.env[k])

test.use({ baseURL: process.env.E2E_BASE_URL })

const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const MODULES_DIR = join(REPO_ROOT, 'modules')

interface ModuleLanding {
  id: string
  enabled: boolean
  segments: string[]
}

function disabledIds(): string[] {
  const file = join(MODULES_DIR, 'disabled.json')
  if (!existsSync(file)) return []
  return (JSON.parse(readFileSync(file, 'utf8')).disabled ?? []).map((e: { id: string }) => e.id)
}

/** Every module with an app/ half and the page segments its manifests declare. */
function moduleLandings(): ModuleLanding[] {
  const off = disabledIds()
  const out: ModuleLanding[] = []
  for (const d of readdirSync(MODULES_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const manifests = join(MODULES_DIR, d.name, 'app', 'lib', 'modules', 'manifests')
    if (!existsSync(manifests)) continue
    const segments = new Set<string>()
    for (const f of readdirSync(manifests)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      for (const m of readFileSync(join(manifests, f), 'utf8').matchAll(/segment:\s*'([^']+)'/g)) segments.add(m[1])
    }
    out.push({ id: d.name, enabled: !off.includes(d.name), segments: [...segments].sort() })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

const LANDINGS = moduleLandings()
const ENABLED = LANDINGS.filter((m) => m.enabled)
const DISABLED = LANDINGS.filter((m) => !m.enabled)

function requireEnv() {
  expect(missingEnv, `missing environment: ${missingEnv.join(', ')}`).toEqual([])
}

async function signInAsAdmin(page: Page) {
  requireEnv()
  await page.goto('/')
  // The app bounces to the Keycloak login theme (docker/keycloak/themes/gremion).
  await page.locator('#username').waitFor()
  await page.locator('#username').fill(process.env.E2E_ADMIN_USER!)
  await page.locator('#password').fill(process.env.E2E_ADMIN_PASS!)
  await page.locator('button[name="login"]').click()
  await page.waitForURL((url) => url.origin === new URL(process.env.E2E_BASE_URL!).origin && !url.pathname.startsWith('/auth'))
}

test.describe('module landing routes', () => {
  test('the repository names at least one enabled module with a landing segment (a vacuous set fails)', () => {
    expect(ENABLED.length, 'no enabled module with an app/ half').toBeGreaterThan(0)
    for (const m of ENABLED) expect(m.segments.length, `module ${m.id} declares no page segment`).toBeGreaterThan(0)
  })

  for (const m of ENABLED) {
    for (const segment of m.segments) {
      test(`enabled module ${m.id}: /${segment} is served (200, main landmark)`, async ({ page }) => {
        await signInAsAdmin(page)
        const response = await page.goto(`/${segment}`)
        expect(response, `no response for /${segment}`).not.toBeNull()
        expect(response!.status(), `/${segment} of the enabled module ${m.id}`).toBe(200)
        await expect(page.locator('main, [role="main"]').first()).toBeVisible()
      })
    }
  }

  for (const m of DISABLED) {
    for (const segment of m.segments) {
      test(`disabled module ${m.id}: /${segment} is a 404`, async ({ page }) => {
        await signInAsAdmin(page)
        const response = await page.goto(`/${segment}`)
        expect(response, `no response for /${segment}`).not.toBeNull()
        expect(response!.status(), `/${segment} of the disabled module ${m.id}`).toBe(404)
      })
    }
  }
})
