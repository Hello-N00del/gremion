import { defineConfig, devices } from '@playwright/test'

// #285 / G-099: the multi-tenant resolver (src/lib/server/tenant/resolve.ts,
// sequence element 0) selects the tenant from the leftmost label of the
// edge-forwarded host (x-forwarded-host) and 404s any request that resolves no
// ACTIVE tenant — including the bare apex. The slug is the LEFTMOST host label
// and the resolver requires >=3 labels (extractLeftmostLabel), so the CI smoke
// job seeds the `default` tenant and sets a 3-label loopback FQDN
// SMOKE_TENANT_HOST=default.localhost.localdomain; when present, stamp it as
// x-forwarded-host on EVERY request (page.goto AND page.request.*) so `/` and
// `/finance` resolve that tenant (→ 302 /auth/login). The smoke job does NOT set
// TENANT_PROXY_SHARED_SECRET, so the resolver trusts x-forwarded-host without a
// proxy-trust header. GATED: absent SMOKE_TENANT_HOST (the normal local/dev e2e
// run) yields no extra headers, so this is a byte-identical no-op outside CI smoke.
const smokeTenantHost = process.env.SMOKE_TENANT_HOST
const extraHTTPHeaders = smokeTenantHost
  ? { 'x-forwarded-host': smokeTenantHost }
  : undefined

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  retries: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    extraHTTPHeaders
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
})
