// TASK-007 / TRD-337 — the acceptance's own falsifying test (PLAN.md:2586):
// "A network trace of the running pilot host's member web app, portal and
// sales site shows zero requests to any third-party font or icon host."
//
// Route choice per brief Sec9's explicit fallback ("either start a throwaway
// Postgres … or audit only routes proven to render 200 without a DB"): `/`
// and `/protokolle` both 500 without GREMION_PUBLIC_DB_URL
// (+page.server.ts awaits getPublishedProtocols with no .catch;
// public-db.ts throws "GREMION_PUBLIC_DB_URL not configured" — verified).
// `/kontakt` is the one page route that reads only env, no DB
// (kontakt/+page.server.ts — verified), so it is the one audited here for
// real; the DB-backed routes are a named residual — see the ledger — for
// whoever wires the throwaway-Postgres fixture (this task's own §9 estimate
// already flags that plumbing as real, not-yet-proven work).
import { test, expect } from '@playwright/test';
import { watchNetwork } from './support/no-third-party-network';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';
const pageOrigin = new URL(baseURL).origin;
const ROUTES = ['/kontakt'];

for (const route of ROUTES) {
  test(`${route} — no third-party font/icon request, self-hosted faces load`, async ({ page }) => {
    const audit = watchNetwork(page, pageOrigin);

    const response = await page.goto(route);
    expect(response, `GET ${route} must produce a response`).not.toBeNull();
    expect(response!.status(), `GET ${route} unexpected status ${response!.status()}`).toBeLessThan(400);

    await page.evaluate(() => document.fonts.ready);

    expect(
      audit.crossOriginRequests,
      `${route}: cross-origin request(s) found — TRD-337 forbids any third-party ` +
        `font/icon host and the allowlist is empty:\n${audit.crossOriginRequests.join('\n')}`
    ).toEqual([]);

    expect(
      audit.sameOriginFontRequests.length,
      `${route}: no same-origin font request observed — a page that loads no fonts ` +
        `at all would pass this audit vacuously, which the helper must not allow`
    ).toBeGreaterThan(0);

    const interLoaded = await page.evaluate(() => document.fonts.check('16px Inter'));
    expect(interLoaded, `${route}: document.fonts.check('16px Inter') is false`).toBe(true);

    const monoLoaded = await page.evaluate(() => document.fonts.check('16px "JetBrains Mono"'));
    expect(monoLoaded, `${route}: document.fonts.check('16px "JetBrains Mono"') is false`).toBe(true);
  });
}
