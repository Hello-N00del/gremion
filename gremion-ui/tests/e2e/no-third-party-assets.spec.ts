// TASK-007 / TRD-337 — the acceptance's own falsifying test (PLAN.md:2586):
// "A network trace of the running pilot host's member web app, portal and
// sales site shows zero requests to any third-party font or icon host."
// This is the member-web-app leg the acceptance names explicitly.
//
// Reuses the existing @smoke boot path (unauthenticated `/`, live `pnpm
// preview`) rather than inventing a new boot env — hooks.server.ts throws at
// boot if the default tenant cannot be resolved (brief Sec9), and the
// smoke.spec.ts precedent already solves that with SMOKE_TENANT_HOST.
import { test, expect } from '@playwright/test'
import { watchNetwork } from './support/no-third-party-network'

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173'
const pageOrigin = new URL(baseURL).origin

test('@smoke / — no third-party font/icon request, self-hosted faces load', async ({ page }) => {
  const audit = watchNetwork(page, pageOrigin)

  const response = await page.goto('/')
  expect(response, 'GET / must produce a response').not.toBeNull()
  expect(response!.status(), `GET / unexpected status ${response!.status()}`).toBeLessThan(500)

  await page.evaluate(() => document.fonts.ready)

  expect(
    audit.crossOriginRequests,
    `cross-origin request(s) found — TRD-337 forbids any third-party font/icon ` +
      `host and the allowlist is empty:\n${audit.crossOriginRequests.join('\n')}`
  ).toEqual([])

  expect(
    audit.sameOriginFontRequests.length,
    'no same-origin font request observed — a page that loads no fonts at all ' +
      'would pass this audit vacuously, which the helper must not allow'
  ).toBeGreaterThan(0)

  const interLoaded = await page.evaluate(() => document.fonts.check('16px Inter'))
  expect(interLoaded, "document.fonts.check('16px Inter') is false").toBe(true)

  const monoLoaded = await page.evaluate(() => document.fonts.check('16px "JetBrains Mono"'))
  expect(monoLoaded, 'document.fonts.check(\'16px "JetBrains Mono"\') is false').toBe(true)
})
