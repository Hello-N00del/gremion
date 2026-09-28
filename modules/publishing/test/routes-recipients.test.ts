// services/newsletter/test/routes-recipients.test.ts
//
// Regression unit test for the kernel↔leaf contract gap introduced at the
// newsletter extraction (commit 25547637): the leaf registered ONLY PUT on
// /api/v1/newsletters/:id/recipients, so the kernel's ServiceNewsletterClient
// GET (getNewsletterRecipients → countNewsletterRecipients → /newsletter page
// loader) hit a 405 → the ACL surfaced a 500. This asserts the GET is now a
// first-class route on the real buildApiRoutes() surface — no PG/NATS needed.
import { describe, it, expect } from 'vitest'
import { createRouter } from '../src/http/router.ts'
import { buildApiRoutes, type StoreFn } from '../src/http/routes.ts'

// storeFn is only invoked INSIDE handlers; route construction + matching never
// calls it, so a throwing stub keeps this a dependency-free routing test.
const stubStore: StoreFn = async () => {
  throw new Error('storeFn must not be called during routing')
}

describe('newsletter leaf routes — GET /api/v1/newsletters/:id/recipients', () => {
  const router = createRouter(buildApiRoutes(stubStore))

  it('routes GET .../recipients (was method-not-allowed → 405 before the fix)', () => {
    const m = router.match('GET', '/api/v1/newsletters/42/recipients')
    expect(m.type).toBe('matched')
    if (m.type !== 'matched') throw new Error('unreachable')
    expect(m.params).toEqual({ id: '42' })
  })

  it('advertises GET alongside PUT in the Allow set for the recipients path', () => {
    // A verb that is neither GET nor PUT must 405 with BOTH now advertised.
    const m = router.match('DELETE', '/api/v1/newsletters/42/recipients')
    expect(m.type).toBe('method-not-allowed')
    if (m.type !== 'method-not-allowed') throw new Error('unreachable')
    expect([...m.allowed].sort()).toEqual(['GET', 'PUT'])
  })
})
