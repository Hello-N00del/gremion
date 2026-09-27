// TASK-007 / TRD-337 Playwright network-request audit helper.
//
// Duplicated verbatim per app (not a shared top-level location — that holds
// bats suites, not any package's TS setup, brief Sec5 Q4) — TASK-171's future
// sales-site app copies this file unchanged.
//
// Collects live REQUESTS (page.on('request'), not responses) so a blocked or
// failed load still counts — a response-based filter would miss the pre-fix
// Google stylesheet request entirely if it were blocked, and misses its
// resourceType ('stylesheet', not 'font') either way.
import type { Page } from '@playwright/test';

export interface NetworkAudit {
  /** every cross-origin request seen (excluding data:/blob:), in order. */
  crossOriginRequests: string[];
  /** every same-origin request whose Playwright resourceType() is 'font'. */
  sameOriginFontRequests: string[];
}

/** Attach BEFORE navigating — Playwright request events fire during page.goto(). */
export function watchNetwork(page: Page, pageOrigin: string): NetworkAudit {
  const audit: NetworkAudit = { crossOriginRequests: [], sameOriginFontRequests: [] };
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (origin !== pageOrigin) {
      // Explicit allowlist: empty today (TRD-337 — no third-party font/icon host).
      audit.crossOriginRequests.push(url);
    } else if (request.resourceType() === 'font') {
      audit.sameOriginFontRequests.push(url);
    }
  });
  return audit;
}
