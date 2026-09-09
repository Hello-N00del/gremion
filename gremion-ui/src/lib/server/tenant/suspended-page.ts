// src/lib/server/tenant/suspended-page.ts
// P2.1c (T6) — the branded, data-plane-free 503 body served for a tenant whose
// control-DB status is `suspended`. A suspended tenant must serve a DISTINCT,
// human-readable page instead of the indistinguishable 404 that
// resolveTenantBySlug returns for any non-active row (registry.ts) — but it must
// NOT touch the tenant data plane (no pool, no config read, no brand hydration):
// a suspended tenant is exactly the case where the data plane may be gone or
// must not be reached.
//
// The HTML is therefore a PURE STRING with a NEUTRAL brand — no institution
// literal anywhere (it must pass T15's repo-wide no-institution-literal guard),
// no per-tenant data, no template interpolation. It carries a stable marker
// (data-tenant-suspended) the resolver test asserts on.

/** Stable marker the resolver test asserts on (kept distinct from any 404/503 body). */
export const SUSPENDED_PAGE_MARKER = 'data-tenant-suspended'

/**
 * The static, data-plane-free 503 body for a suspended tenant. Pure: no I/O, no
 * per-tenant data, no institution literal. Neutral brand by construction.
 */
export const SUSPENDED_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service unavailable</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; font-family: system-ui, -apple-system, Segoe UI, Roboto,
    Helvetica, Arial, sans-serif; background: #f5f5f5; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #161616; color: #ededed; } }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
  p { font-size: 1rem; line-height: 1.5; margin: 0.5rem 0; opacity: 0.85; }
</style>
</head>
<body ${SUSPENDED_PAGE_MARKER}>
<main>
<h1>This service is currently unavailable</h1>
<p>This workspace has been temporarily suspended.</p>
<p>If you believe this is a mistake, please contact your administrator.</p>
</main>
</body>
</html>
`

/**
 * Build the 503 Response for a suspended tenant. No data-plane access — the
 * caller is on the registry NULL path precisely because the tenant is not
 * active, so nothing per-tenant is hydrated here.
 */
export function suspendedTenantResponse(): Response {
  return new Response(SUSPENDED_PAGE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': '3600',
    },
  })
}
