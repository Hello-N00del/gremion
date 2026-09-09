// gremion-public/tests/e2e/public-portal.spec.ts
// Playwright E2E tests for the public portal.
// These run against a live server — set PLAYWRIGHT_BASE_URL to the target.

import { test, expect } from '@playwright/test';

// ── Home page ─────────────────────────────────────────────────────────────────

test.describe('Home page', () => {
  test('renders the StuRa portal heading', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/StuRa/i);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('StuRa');
  });

  test('has a skip-to-content link as first focusable element', async ({ page }) => {
    await page.goto('/');
    // Tab once from the top of the page — the skip link should be reachable
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '#main-content');
  });

  test('main navigation links are present', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link', { name: 'Aktuelles' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Termine' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Protokolle' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Kontakt' })).toBeVisible();
  });

  test('nav links point to correct routes', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await expect(nav.getByRole('link', { name: 'Aktuelles' })).toHaveAttribute('href', '/aktuelles');
    await expect(nav.getByRole('link', { name: 'Termine' })).toHaveAttribute('href', '/termine');
    await expect(nav.getByRole('link', { name: 'Protokolle' })).toHaveAttribute('href', '/protokolle');
    await expect(nav.getByRole('link', { name: 'Kontakt' })).toHaveAttribute('href', '/kontakt');
  });

  test('page has accessible main landmark', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#main-content')).toBeVisible();
  });
});

// ── Navigation ────────────────────────────────────────────────────────────────

test.describe('Navigation', () => {
  test('clicking Aktuelles navigates to /aktuelles', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Aktuelles' })
      .click();
    await expect(page).toHaveURL(/\/aktuelles/);
  });

  test('clicking Termine navigates to /termine', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Termine' })
      .click();
    await expect(page).toHaveURL(/\/termine/);
  });

  test('clicking Protokolle navigates to /protokolle', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Protokolle' })
      .click();
    await expect(page).toHaveURL(/\/protokolle/);
  });

  test('clicking Kontakt navigates to /kontakt', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Hauptnavigation' })
      .getByRole('link', { name: 'Kontakt' })
      .click();
    await expect(page).toHaveURL(/\/kontakt/);
  });
});

// ── Aktuelles ─────────────────────────────────────────────────────────────────

test.describe('Aktuelles (/aktuelles)', () => {
  test('renders the page heading', async ({ page }) => {
    await page.goto('/aktuelles');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Aktuelles');
  });

  test('page title contains StuRa', async ({ page }) => {
    await page.goto('/aktuelles');
    await expect(page).toHaveTitle(/StuRa/i);
  });

  test('shows empty state or news list — no unhandled error', async ({ page }) => {
    const response = await page.goto('/aktuelles');
    expect(response?.status()).toBeLessThan(500);
  });
});

// ── Termine ───────────────────────────────────────────────────────────────────

test.describe('Termine (/termine)', () => {
  test('renders the page heading', async ({ page }) => {
    await page.goto('/termine');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Termine');
  });

  test('shows month navigation controls', async ({ page }) => {
    await page.goto('/termine');
    const nav = page.getByRole('navigation', { name: 'Monatsnavigation' });
    await expect(nav).toBeVisible();
  });

  test('iCal download link is present', async ({ page }) => {
    await page.goto('/termine');
    const icsLink = page.getByRole('link', { name: /iCal/i });
    await expect(icsLink).toBeVisible();
    await expect(icsLink).toHaveAttribute('href', '/termine/kalender.ics');
  });

  test('clicking "Weiter" updates the month param', async ({ page }) => {
    await page.goto('/termine');
    const nextLink = page.getByRole('link', { name: 'Weiter →' });
    if (await nextLink.isVisible()) {
      await nextLink.click();
      await expect(page).toHaveURL(/monat=/);
    }
  });
});

// ── iCal feed ─────────────────────────────────────────────────────────────────

test.describe('iCal feed (/termine/kalender.ics)', () => {
  test('returns 200 with text/calendar content type', async ({ request }) => {
    const response = await request.get('/termine/kalender.ics');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/calendar');
  });

  test('response body starts with BEGIN:VCALENDAR', async ({ request }) => {
    const response = await request.get('/termine/kalender.ics');
    const body = await response.text();
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });

  test('response body ends with END:VCALENDAR', async ({ request }) => {
    const response = await request.get('/termine/kalender.ics');
    const body = await response.text();
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });
});

// ── Protokolle ────────────────────────────────────────────────────────────────

test.describe('Protokolle (/protokolle)', () => {
  test('renders the page heading', async ({ page }) => {
    await page.goto('/protokolle');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Protokolle');
  });

  test('shows empty state or protocol list — no unhandled error', async ({ page }) => {
    const response = await page.goto('/protokolle');
    expect(response?.status()).toBeLessThan(500);
  });
});

// ── Kontakt ───────────────────────────────────────────────────────────────────

test.describe('Kontakt (/kontakt)', () => {
  test('renders the page heading', async ({ page }) => {
    await page.goto('/kontakt');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Kontakt');
  });

  test('has Kontaktdaten section', async ({ page }) => {
    await page.goto('/kontakt');
    await expect(page.getByRole('heading', { name: 'Kontaktdaten' })).toBeVisible();
  });

  test('has Impressum section', async ({ page }) => {
    await page.goto('/kontakt');
    await expect(page.getByRole('heading', { name: 'Impressum' })).toBeVisible();
  });
});

// ── 404 handling ──────────────────────────────────────────────────────────────

test.describe('404 handling', () => {
  test('unknown routes return 404', async ({ request }) => {
    const response = await request.get('/gibts-nicht-' + Date.now());
    expect(response.status()).toBe(404);
  });

  test('unknown news slug returns 404', async ({ request }) => {
    const response = await request.get('/aktuelles/this-slug-does-not-exist-xyzabc');
    expect(response.status()).toBe(404);
  });

  test('unknown protocol id returns 404', async ({ request }) => {
    const response = await request.get('/protokolle/999999999');
    expect(response.status()).toBe(404);
  });
});

// ── Accessibility ─────────────────────────────────────────────────────────────

test.describe('Accessibility', () => {
  test('home page has correct lang attribute (de)', async ({ page }) => {
    await page.goto('/');
    const htmlLang = await page.locator('html').getAttribute('lang');
    expect(htmlLang).toBe('de');
  });

  test('home page has a unique h1', async ({ page }) => {
    await page.goto('/');
    const h1s = page.locator('h1');
    await expect(h1s).toHaveCount(1);
  });

  test('aktuelles page has a unique h1', async ({ page }) => {
    await page.goto('/aktuelles');
    const h1s = page.locator('h1');
    await expect(h1s).toHaveCount(1);
  });

  test('termine page has a unique h1', async ({ page }) => {
    await page.goto('/termine');
    const h1s = page.locator('h1');
    await expect(h1s).toHaveCount(1);
  });

  test('protokolle page has a unique h1', async ({ page }) => {
    await page.goto('/protokolle');
    const h1s = page.locator('h1');
    await expect(h1s).toHaveCount(1);
  });

  test('kontakt page has a unique h1', async ({ page }) => {
    await page.goto('/kontakt');
    const h1s = page.locator('h1');
    await expect(h1s).toHaveCount(1);
  });
});
