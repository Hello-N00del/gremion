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

  // A decision nobody has voted on yet (0/0/0) is a placeholder, not a decision, so it can be
  // added even before the attendance is recorded. It is stored and listed, then deleted again
  // so that the submit test below is not blocked by a resolution without a vote. (A decision
  // with votes needs members marked present, which this fixture does not seed.)
  test('admin can add a resolution without a vote and delete it', async ({ page }) => {
    await page.goto(`/members/committees/${COMMITTEE_ID}/protokolle`)
    await page.click('text=E2E Testprotokoll')
    await page.click('text=+ Beschluss hinzufügen')
    await page.fill('[placeholder="Beschlusstext"]', 'Testbeschluss: noch ohne Abstimmung')
    await page.getByLabel('Ja', { exact: true }).fill('0')
    await page.getByLabel('Nein', { exact: true }).fill('0')
    await page.getByLabel('Enthaltung', { exact: true }).fill('0')
    await page.click('text=Speichern')
    await expect(page.getByText('Testbeschluss: noch ohne Abstimmung')).toBeVisible()
    await page.click('text=✕')
    await expect(page.getByText('Testbeschluss: noch ohne Abstimmung')).not.toBeVisible()
  })

  // A decision has to fit the meeting: this protocol has no recorded attendance, so a
  // count far above any roster is refused (not quorate, or more votes than members
  // present), with a German message, and nothing is stored. The post-condition is the
  // stored list, not the form: the open form may still show a computed preview.
  test('admin cannot save a decision that does not fit the attendance', async ({ page }) => {
    const created: number[] = []
    page.on('response', (res) => {
      if (res.request().method() === 'POST' && /\/api\/protocols\/[^/]+\/resolutions$/.test(res.url())) {
        created.push(res.status())
      }
    })
    await page.goto(`/members/committees/${COMMITTEE_ID}/protokolle`)
    await page.click('text=E2E Testprotokoll')
    await page.click('text=+ Beschluss hinzufügen')
    await page.fill('[placeholder="Beschlusstext"]', 'Testbeschluss: Einstimmig angenommen')
    await page.getByLabel('Ja', { exact: true }).fill('999')
    await page.getByLabel('Nein', { exact: true }).fill('0')
    await page.getByLabel('Enthaltung', { exact: true }).fill('0')
    await page.click('text=Speichern')
    await expect(page.getByRole('alert')).toContainText(/Nicht beschlussfähig|übersteigen/)
    // No verdict next to the refusal, and no request that stored the decision.
    await expect(page.getByText('Angenommen')).not.toBeVisible()
    expect(created.filter((status) => status === 201)).toEqual([])
    // Nothing was stored: the decision is not in the list after a reload either.
    await page.reload()
    await expect(page.getByText('Testbeschluss: Einstimmig angenommen')).not.toBeVisible()
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
