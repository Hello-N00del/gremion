import { test, expect } from '@playwright/test'

test('unauthenticated user is redirected to login', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/auth\/login/)
})

test('login page shows Keycloak sign-in button', async ({ page }) => {
  await page.goto('/auth/login')
  await expect(page.getByRole('button', { name: /anmelden/i })).toBeVisible()
})

test('legal pages are accessible without login', async ({ page }) => {
  await page.goto('/legal/impressum')
  await expect(page).not.toHaveURL(/\/auth\/login/)
  await expect(page.getByRole('heading', { name: 'Impressum' })).toBeVisible()
})

test('datenschutz page accessible without login', async ({ page }) => {
  await page.goto('/legal/datenschutz')
  await expect(page.getByRole('heading', { name: 'Datenschutzerklärung' })).toBeVisible()
})
