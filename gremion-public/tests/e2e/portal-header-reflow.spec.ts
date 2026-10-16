// gremion-public/tests/e2e/portal-header-reflow.spec.ts
// Portal header reflow: at 390 px the header wraps the institution name to at
// most two lines (never truncated), keeps the member-login CTA on-screen
// ("Login" below `sm`, the full label stays in the accessible name) and has no
// horizontal overflow (WCAG 1.4.10 Reflow). Runs against a live server: set
// PLAYWRIGHT_BASE_URL, and start that server with PUBLIC_MAIN_APP_URL set so
// the CTA renders (an unconfigured kernel renders no CTA, and the CTA checks
// skip). The header lives in the root layout, so `/kontakt` stands in for
// every portal page.

import { test, expect, type Page } from '@playwright/test';

// A long, neutral institution name; set in the DOM so the check does not
// depend on which PUBLIC_CONTACT_NAME the target server was started with.
const LONG_NAME = 'Studierendenvertretung der Beispielhochschule Nord';

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
