// gremion-public/tests/e2e/portal-header-reflow.spec.ts
// Portal header reflow: at 390 px the header wraps the institution name to at
// most two lines (never truncated), keeps the member-login CTA on-screen
// ("Login" below `sm`, the full label stays in the accessible name) and has no
// horizontal overflow (WCAG 1.4.10 Reflow). Runs against a live server: set
// PLAYWRIGHT_BASE_URL, and start that server with PUBLIC_MAIN_APP_URL set so
// the CTA renders (an unconfigured kernel renders no CTA, and the CTA checks
// skip). The header lives in the root layout, so `/kontakt` stands in for
// every portal page.
//
// A ~75-character name also fits two lines at 390 px, and neither the header nor
// the utility bar overflows at 360 px.

import { test, expect, type Page } from '@playwright/test';

// A long, neutral institution name; set in the DOM so the check does not
// depend on which PUBLIC_CONTACT_NAME the target server was started with.
const LONG_NAME = 'Studierendenvertretung der Beispielhochschule Nord';

// ~75 characters: three lines beside the login pill at 390 px, so below `sm` the
// header lays the name out beneath the brand mark at the full row width, in 15px
// type, where it fits two lines.
const LONG_NAME_75 = 'Studierendenvertretung der Beispielhochschule für angewandte Wissenschaften';

async function setName(page: Page, name: string) {
  await page.getByTestId('portal-institution-name').evaluate((el, n) => {
    el.textContent = n;
  }, name);
}

async function nameMetrics(page: Page) {
  return page.getByTestId('portal-institution-name').evaluate((el) => {
    const cs = getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    return {
      height: el.getBoundingClientRect().height,
      lineHeight,
      clipped: el.scrollWidth > el.clientWidth || cs.textOverflow === 'ellipsis',
    };
  });
}

test.describe('Portal header at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/kontakt');
    await page.waitForLoadState('networkidle'); // dev servers inject CSS after `load`
    await page.getByTestId('portal-institution-name').evaluate((el, name) => {
      el.textContent = name;
    }, LONG_NAME);
  });

  test('has no horizontal overflow', async ({ page }) => {
    const m = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="portal-header"]') as HTMLElement;
      return {
        doc: document.documentElement.scrollWidth,
        header: header.scrollWidth,
        headerBox: header.clientWidth,
      };
    });
    expect(m.doc).toBeLessThanOrEqual(390);
    expect(m.header).toBeLessThanOrEqual(m.headerBox);
  });

  test('wraps the institution name to at most two lines, untruncated', async ({ page }) => {
    const name = page.getByTestId('portal-institution-name');
    await expect(name).toBeVisible();
    await expect(name).toHaveText(LONG_NAME);
    const m = await nameMetrics(page);
    expect(m.height).toBeGreaterThan(m.lineHeight * 1.5); // it really wrapped
    expect(m.height).toBeLessThanOrEqual(m.lineHeight * 2 + 1);
    expect(m.clipped).toBe(false);
  });

  test('fits a ~75-character institution name in at most two lines, untruncated', async ({ page }) => {
    expect(LONG_NAME_75.length).toBeGreaterThanOrEqual(75);
    await setName(page, LONG_NAME_75);
    const name = page.getByTestId('portal-institution-name');
    await expect(name).toHaveText(LONG_NAME_75);
    const m = await nameMetrics(page);
    expect(m.height).toBeGreaterThan(m.lineHeight * 1.5); // it really wrapped
    expect(m.height).toBeLessThanOrEqual(m.lineHeight * 2 + 1);
    expect(m.clipped).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('keeps the login CTA on-screen with the short label', async ({ page }) => {
    const cta = page.getByTestId('portal-login-cta');
    test.skip((await cta.count()) === 0, 'server started without PUBLIC_MAIN_APP_URL: no CTA rendered');
    await expect(cta).toBeVisible();
    // Only the short label is painted below `sm`: the rest is visually hidden
    // (1px sr-only box) but stays in the accessible name.
    const hidden = page.getByTestId('portal-login-cta-suffix');
    await expect(hidden).toHaveCount(1);
    expect((await hidden.boundingBox())!.width).toBeLessThanOrEqual(1);
    await expect(cta).toHaveAccessibleName(/Login\s*·\s*Mitglieder/);
    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});

test.describe('Portal header at 360 px', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('has no horizontal overflow, utility bar included', async ({ page }) => {
    await page.goto('/kontakt');
    await page.waitForLoadState('networkidle');
    await setName(page, LONG_NAME_75);
    const m = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="portal-header"]') as HTMLElement;
      const bar = document.querySelector('[data-testid="portal-utility-bar"]') as HTMLElement;
      return {
        doc: document.documentElement.scrollWidth,
        header: header.scrollWidth,
        headerBox: header.clientWidth,
        bar: bar.scrollWidth,
        barBox: bar.clientWidth,
      };
    });
    expect(m.doc).toBeLessThanOrEqual(360);
    expect(m.header).toBeLessThanOrEqual(m.headerBox);
    expect(m.bar).toBeLessThanOrEqual(m.barBox);
  });
});

test.describe('Portal header on desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps a short institution name on one line', async ({ page }) => {
    await page.goto('/kontakt');
    const m = await nameMetrics(page);
    expect(m.height).toBeLessThanOrEqual(m.lineHeight + 1);
  });

  test('shows the full login label', async ({ page }) => {
    await page.goto('/kontakt');
    const cta = page.getByTestId('portal-login-cta');
    test.skip((await cta.count()) === 0, 'server started without PUBLIC_MAIN_APP_URL: no CTA rendered');
    await expect(cta).toContainText('Login');
    await expect(cta).toContainText('Mitglieder');
  });
});
