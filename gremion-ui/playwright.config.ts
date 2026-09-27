import { defineConfig, devices } from '@playwright/test'

// #285 / G-099: the multi-tenant resolver (src/lib/server/tenant/resolve.ts,
// sequence element 0) selects the tenant by the WHOLE edge-forwarded host
// (x-forwarded-host, looked up in tenant_domain; TASK-041) and 404s any request
// whose host is not bound to an ACTIVE tenant — including the bare apex. When
// SMOKE_TENANT_HOST is present, stamp it as x-forwarded-host on EVERY request
// (page.goto AND page.request.*) so `/` and `/finance` resolve the tenant bound
// to it (→ 302 /auth/login). The host resolves ONLY if the run bound it via
// addTenantDomain first: the default tenant binds no host (TRD-075), so the
// old CI smoke host default.localhost.localdomain no longer resolves by itself
// (TASK-041 Q8; TASK-042's fixture factory binds what it stamps). The smoke job
// does NOT set TENANT_PROXY_SHARED_SECRET, so the resolver trusts
// x-forwarded-host without a proxy-trust header. GATED: absent SMOKE_TENANT_HOST
// (the normal local/dev e2e run) yields no extra headers, so this is a
// byte-identical no-op outside CI smoke.
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
