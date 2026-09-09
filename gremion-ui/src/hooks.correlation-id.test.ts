/**
 * T16 — Unit tests for the correlationHandle (propagation point 1).
 *
 * TDD proof:
 *  - Header present with valid UUID → same id in event.locals.correlationId.
 *  - Header absent → fresh UUID minted (never the client's value).
 *  - Header is garbage / oversized → fresh UUID minted.
 *
 * Propagation rule 5: NEVER trust client-supplied id for auth; re-mint when
 * absent, oversized, or non-UUID-grammar.
 */
import { describe, it, expect, vi } from 'vitest'

// ── Module stubs (must precede the hooks.server import) ──────────────────────
vi.mock('$app/environment', () => ({ building: true }))
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgresql://gremion:gremion@localhost:5432/gremion' } }))
vi.mock('$lib/server/db', () => ({ waitForDbReady: vi.fn(async () => {}), runMigrations: vi.fn(async () => {}), getDb: () => ({}) }))
vi.mock('$lib/server/config', () => ({ readConfig: () => ({ smtp: { configured: false }, modules: { finance: true }, retention: { security_logs_days: 90 } }) }))
vi.mock('$lib/server/calendar/notification-scheduler', () => ({ startNotificationScheduler: vi.fn() }))
vi.mock('$lib/server/calendar/caldav-sync', () => ({ startCalDavSyncWorker: vi.fn() }))
vi.mock('$lib/server/governance/provisioning/worker', () => ({ startProvisioningWorker: vi.fn() }))
vi.mock('$lib/server/audit-db', () => ({ purgeAuditLogsOlderThan: vi.fn(async () => ({ purged: 0 })) }))
vi.mock('./auth', () => ({ handle: async ({ event, resolve }: { event: unknown; resolve: (e: unknown) => unknown }) => resolve(event) }))
vi.mock('$lib/server/jwt-verify', () => ({ verifyBearerJwt: vi.fn(async () => null) }))
vi.mock('$lib/server/tenant/control-migrations', () => ({ runControlMigrations: vi.fn(async () => {}) }))
vi.mock('$lib/server/tenant/register-default', () => ({ registerDefaultTenant: vi.fn(async () => ({ id: 'tid-1' })) }))
vi.mock('$lib/server/tenant/registry', () => ({
  resolveTenantBySlug: vi.fn(async () => ({ id: 'default', slug: 'default', issuer: 'https://kc/realms/sturaos' })),
  listActiveTenants: vi.fn(async () => [{ id: 'tid-1', slug: 'default', status: 'active' }]),
  startTenantMigrationRun: vi.fn(async () => 'run-1'),
  finishTenantMigrationRun: vi.fn(async () => {}),
}))
vi.mock('$lib/server/tenant/context', () => ({ runWithTenant: (_ctx: unknown, fn: () => unknown) => fn(), getTenantOrNull: () => null }))
vi.mock('$lib/server/tenant/default-tenant', () => ({ DEFAULT_TENANT: { id: 'default', configPath: '/tmp/config.json' } }))
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }))
vi.mock('$lib/server/events/newsletter-audit-consumer', () => ({ startNewsletterAuditConsumer: vi.fn() }))
// ── end stubs ─────────────────────────────────────────────────────────────────

import { correlationHandle } from './hooks.server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Build a minimal SvelteKit event for testing correlationHandle. */
function makeEvent(correlationHeader: string | null): { request: Request; locals: Record<string, unknown> } {
  const headers = new Headers()
  if (correlationHeader !== null) {
    headers.set('x-correlation-id', correlationHeader)
  }
  return {
    request: new Request('https://example.com/', { headers }),
    locals: {},
  }
}

/** Invoke correlationHandle and return the populated locals. */
async function runHandle(correlationHeader: string | null): Promise<Record<string, unknown>> {
  const event = makeEvent(correlationHeader)
  await correlationHandle({
    event: event as never,
    resolve: async () => new Response('ok'),
  })
  return event.locals
}

describe('T16 — correlationHandle (propagation point 1)', () => {
  it('header present with valid UUID → same id stored in event.locals.correlationId', async () => {
    const validUuid = '550e8400-e29b-41d4-a716-446655440000'
    const locals = await runHandle(validUuid)
    expect(locals['correlationId']).toBe(validUuid)
  })

  it('header absent → fresh UUID minted (never the client value)', async () => {
    const locals = await runHandle(null)
    expect(locals['correlationId']).toMatch(UUID_RE)
  })

  it('header is empty string → fresh UUID minted', async () => {
    const locals = await runHandle('')
    expect(locals['correlationId']).toMatch(UUID_RE)
    expect(locals['correlationId']).not.toBe('')
  })

  it('header is garbage (non-UUID grammar) → fresh UUID minted, garbage discarded', async () => {
    const locals = await runHandle('not-a-uuid')
    expect(locals['correlationId']).toMatch(UUID_RE)
    expect(locals['correlationId']).not.toBe('not-a-uuid')
  })

  it('header is oversized (> 36 chars) → fresh UUID minted, oversized value discarded', async () => {
    const oversized = '550e8400-e29b-41d4-a716-446655440000-EXTRA'
    const locals = await runHandle(oversized)
    expect(locals['correlationId']).toMatch(UUID_RE)
    expect(locals['correlationId']).not.toBe(oversized)
  })

  it('two requests with the same valid UUID header → both get that UUID (header propagated)', async () => {
    const validUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const [loc1, loc2] = await Promise.all([
      runHandle(validUuid),
      runHandle(validUuid),
    ])
    expect(loc1['correlationId']).toBe(validUuid)
    expect(loc2['correlationId']).toBe(validUuid)
  })

  it('two requests without a header → each gets a DIFFERENT fresh UUID', async () => {
    const loc1 = await runHandle(null)
    const loc2 = await runHandle(null)
    expect(loc1['correlationId']).toMatch(UUID_RE)
    expect(loc2['correlationId']).toMatch(UUID_RE)
    expect(loc1['correlationId']).not.toBe(loc2['correlationId'])
  })
})
