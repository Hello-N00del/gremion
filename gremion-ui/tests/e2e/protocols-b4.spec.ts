import { test, expect } from '@playwright/test'

const COMMITTEE_ID = process.env.TEST_COMMITTEE_ID ?? 'test-committee-id'

test.describe('B4 — Meeting Minutes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth/login')
    await page.fill('[name="email"]', process.env.TEST_ADMIN_EMAIL ?? 'admin@test.local')
    await page.fill('[name="password"]', process.env.TEST_ADMIN_PASSWORD ?? 'admin')
    await page.click('[type="submit"]')
    await page.waitForURL('/')
  })

  test('admin can create a protocol', async ({ page }) => {
    await page.goto(`/members/committees/${COMMITTEE_ID}/protokolle/new`)
    await page.fill('[name="title"]', 'E2E Testprotokoll')
    await page.fill('[name="meetingDate"]', '2026-04-20')
    await page.click('[type="submit"]')
    await expect(page).toHaveURL(/\/members\/committees\/.+\/protokolle\/.+/)
    await expect(page.locator('text=E2E Testprotokoll')).toBeVisible()
    await expect(page.locator('text=Entwurf')).toBeVisible()
  })

  test('protocol list shows new protocol as draft', async ({ page }) => {
    await page.goto(`/members/committees/${COMMITTEE_ID}/protokolle`)
    await expect(page.locator('text=E2E Testprotokoll')).toBeVisible()
    await expect(page.locator('text=Entwurf')).toBeVisible()
  })

  test('admin can add a resolution to the protocol', async ({ page }) => {
    await page.goto(`/members/committees/${COMMITTEE_ID}/protokolle`)
    await page.click('text=E2E Testprotokoll')
    await page.click('text=+ Beschluss hinzufügen')
    await page.fill('[placeholder="Beschlusstext"]', 'Testbeschluss: Einstimmig angenommen')
    await page.fill('[placeholder="Ja"]', '10')
    await page.fill('[placeholder="Nein"]', '0')
    await page.click('text=Speichern')
    await expect(page.locator('text=Testbeschluss: Einstimmig angenommen')).toBeVisible()
  })

  test('admin can submit protocol for vote', async ({ page }) => {
    await page.goto(`/members/committees/${COMMITTEE_ID}/protokolle`)
    await page.click('text=E2E Testprotokoll')
    await page.click('text=Zur Abstimmung einreichen')
    await expect(page.locator('text=Eingereicht')).toBeVisible()
    await expect(page.locator('iframe[title="Protokoll bearbeiten"]')).not.toBeVisible()
  })

  test('guest can read draft protocol in the admin shell', async ({ page }) => {
    await page.goto('/auth/logout')
    await page.goto('/auth/login')
    await page.fill('[name="email"]', process.env.TEST_GUEST_EMAIL ?? 'guest@test.local')
    await page.fill('[name="password"]', process.env.TEST_GUEST_PASSWORD ?? 'guest')
    await page.click('[type="submit"]')
    await page.waitForURL('/')

    await page.goto(`/members/committees/${COMMITTEE_ID}/protokolle`)
    await expect(page.locator('text=E2E Testprotokoll')).toBeVisible()
    await page.click('text=E2E Testprotokoll')
    await expect(page.locator('iframe[title="Protokoll bearbeiten"]')).not.toBeVisible()
    await expect(page.locator('text=Zur Abstimmung einreichen')).not.toBeVisible()
  })

  test('Beschlussregister shows published resolutions', async ({ page }) => {
    await page.goto(`/members/committees/${COMMITTEE_ID}/beschluesse`)
    await expect(page.locator('h2', { hasText: 'Beschlussregister' })).toBeVisible()
  })
})
