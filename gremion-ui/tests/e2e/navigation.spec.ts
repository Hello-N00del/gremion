import { test, expect } from '@playwright/test'

test('protected routes redirect to login when unauthenticated', async ({ page }) => {
  // Carve note: /files, /messages, /calendar, /elections, /finance, /users were
  // dropped when their feature modules were carved out of the governance-only
  // kernel (see src/lib/modules/manifests/{core,governance}.ts — only
  // dashboard/settings/systemstatus/members/committees/portal/protokolle/
  // beschluesse remain). /settings is the one entry from the original list that
  // is still a real kernel route, so it is the only one left to assert against.
  const protectedRoutes = ['/settings']

  for (const route of protectedRoutes) {
    await page.goto(route)
    await expect(page, `Expected ${route} to redirect to login`).toHaveURL(/\/auth\/login/)
  }
})

test('sidebar is not shown on login page', async ({ page }) => {
  await page.goto('/auth/login')
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).not.toBeVisible()
})
