// T2 (#320 contestability): route-level gating for the resolution-challenge
// channel — POST /api/protocols/resolutions/[resId]/challenges (member files a
// challenge) and PATCH .../challenges/[challengeId] (admin disposition).
//
// Mock pattern per the sibling assign.reconcile.test.ts: the service module
// (resolution-challenges-db) is mocked and the ROUTES are driven directly.
// Auth follows the sibling resolutions/[resId]/+server.ts requireAdmin
// convention (event.locals.user); FILING is a member act — any authenticated
// session may POST, no CouncilAdmin needed — while DISPOSITION is admin-only.
//
// Pinned contract:
//   (a) unauthenticated POST → 401
//   (b) authenticated plain member POST with grounds → 201 (challenge returned)
//   (c) POST with empty/whitespace grounds → 400, service never called
//   (d) second POST while the same user's open challenge exists → 409
//       (service raises DuplicateOpenChallengeError)
//   (e) PATCH by a non-admin → 403, service never called
//   (f) admin PATCH status→'upheld' with decision_note → 200

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Role } from '$lib/auth'

const h = vi.hoisted(() => ({
  fileChallenge: vi.fn(),
  decideChallenge: vi.fn(),
}))

// Factory-defined error classes: the routes import these from the SAME mocked
// module, so `instanceof` mapping in the handlers works against the instances
// the mocked service rejects with.
vi.mock('$lib/server/governance/resolution-challenges-db', () => {
  class DuplicateOpenChallengeError extends Error {
    constructor() {
      super('duplicate open challenge')
      this.name = 'DuplicateOpenChallengeError'
    }
  }
  class ResolutionNotFoundError extends Error {
    constructor() {
      super('resolution not found')
      this.name = 'ResolutionNotFoundError'
    }
  }
  class ChallengeNotOpenError extends Error {
    constructor() {
      super('challenge not open')
      this.name = 'ChallengeNotOpenError'
    }
  }
  class ResolutionNotAdoptedError extends Error {
    constructor() {
      super('resolution not adopted')
      this.name = 'ResolutionNotAdoptedError'
    }
  }
  return {
    fileChallenge: h.fileChallenge,
    decideChallenge: h.decideChallenge,
    DuplicateOpenChallengeError,
    ResolutionNotFoundError,
    ChallengeNotOpenError,
    ResolutionNotAdoptedError,
  }
})

const { POST } = await import('./+server')
const { PATCH } = await import('./[challengeId]/+server')
const { DuplicateOpenChallengeError, ChallengeNotOpenError, ResolutionNotAdoptedError } =
  await import('$lib/server/governance/resolution-challenges-db')

// Plain member: authenticated but NOT CouncilAdmin — filing must work for them.
const MEMBER = { id: 'member-1', roles: [Role.Member], groups: [], email: 'm@example.org', name: 'M' }
const ADMIN = { id: 'admin-1', roles: [Role.CouncilAdmin], groups: [], email: 'a@example.org', name: 'A' }

// Row vocabulary per migration 055 (raised_by / resolved_by / resolved_at /
// decision_note — all folded into the resolution_challenges CREATE).
const OPEN_CHALLENGE = {
  id: 'ch-1',
  resolution_id: 'res-1',
  raised_by: 'member-1',
  grounds: 'Verstoß gegen §7 der Geschäftsordnung',
  status: 'open',
  resolved_by: null,
  resolved_at: null,
  decision_note: null,
  created_at: '2026-07-22T10:00:00Z',
}

function postEvent(body: unknown, user: unknown = MEMBER) {
  return {
    locals: { user },
    params: { resId: 'res-1' },
    request: { json: async () => body },
  } as unknown as Parameters<typeof POST>[0]
}

function patchEvent(body: unknown, user: unknown = ADMIN) {
  return {
    locals: { user },
    params: { resId: 'res-1', challengeId: 'ch-1' },
    request: { json: async () => body },
  } as unknown as Parameters<typeof PATCH>[0]
}

beforeEach(() => {
  h.fileChallenge.mockReset().mockResolvedValue(OPEN_CHALLENGE)
  h.decideChallenge.mockReset().mockImplementation(async (input: { status: string; decisionNote: string | null }) => ({
    ...OPEN_CHALLENGE,
    status: input.status,
    decision_note: input.decisionNote,
    resolved_by: 'admin-1',
    resolved_at: '2026-07-22T11:00:00Z',
  }))
})

describe('POST /api/protocols/resolutions/[resId]/challenges — member files a challenge', () => {
  it('(a) unauthenticated → 401, service never called', async () => {
    // `null` (not `undefined`): an explicit undefined would trigger the helper's
    // default MEMBER parameter. Both are falsy to requireUser.
    await expect(
      POST(postEvent({ grounds: 'Verstoß gegen §7' }, null)),
    ).rejects.toMatchObject({ status: 401 })
    expect(h.fileChallenge).not.toHaveBeenCalled()
  })

  // TASK-206-A review: filing is a MEMBER act. A guest (or a session without a
  // role) can see no committee business and must not plant an audit row and a
  // public "Einspruch offen" badge on any resolution id it learns.
  it.each([
    ['a guest', [Role.Guest]],
    ['a session without roles', []],
  ])('(a2) %s → 403, service never called', async (_n, roles) => {
    const outsider = { id: 'guest-1', roles, groups: [], email: 'g@example.org', name: 'G' }
    await expect(
      POST(postEvent({ grounds: 'Verstoß gegen §7' }, outsider as never)),
    ).rejects.toMatchObject({ status: 403 })
    expect(h.fileChallenge).not.toHaveBeenCalled()
  })

  it('(b) authenticated plain member (no CouncilAdmin) with grounds → 201', async () => {
    const res = await POST(postEvent({ grounds: 'Verstoß gegen §7 der Geschäftsordnung' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.challenge).toMatchObject({ id: 'ch-1', status: 'open' })
    // The challenger is the SESSION user and the resolution comes from the URL —
    // never from the request body.
    expect(h.fileChallenge).toHaveBeenCalledWith({
      resolutionId: 'res-1',
      raisedBy: 'member-1',
      grounds: 'Verstoß gegen §7 der Geschäftsordnung',
    })
  })

  it.each(['', '   ', undefined, null, 42])(
    '(c) grounds %j → 400, nothing filed',
    async (grounds) => {
      await expect(POST(postEvent({ grounds }))).rejects.toMatchObject({ status: 400 })
      expect(h.fileChallenge).not.toHaveBeenCalled()
    },
  )

  it('(d) second POST while an open challenge by the same user exists → 409', async () => {
    const first = await POST(postEvent({ grounds: 'Verstoß gegen §7' }))
    expect(first.status).toBe(201)

    h.fileChallenge.mockRejectedValueOnce(new DuplicateOpenChallengeError('res-1', 'member-1'))
    await expect(POST(postEvent({ grounds: 'Verstoß gegen §7' }))).rejects.toMatchObject({
      status: 409,
    })
  })

  it('(g) filing against a resolution that was never adopted → 403', async () => {
    // #437: only an ADOPTED resolution can be contested. The service refuses
    // when decided_at IS NULL (protocol still draft/submitted); the route must
    // surface that as 403, not leak it as a 500.
    h.fileChallenge.mockRejectedValueOnce(new ResolutionNotAdoptedError('res-1'))
    await expect(POST(postEvent({ grounds: 'Verstoß gegen §7' }))).rejects.toMatchObject({
      status: 403,
    })
  })
})

describe('PATCH /api/protocols/resolutions/[resId]/challenges/[challengeId] — admin disposition', () => {
  it('(e) non-admin PATCH → 403, service never called', async () => {
    await expect(
      PATCH(patchEvent({ status: 'upheld', decision_note: 'stattgegeben' }, MEMBER)),
    ).rejects.toMatchObject({ status: 403 })
    expect(h.decideChallenge).not.toHaveBeenCalled()
  })

  it('(e2) unauthenticated PATCH → 401', async () => {
    await expect(
      PATCH(patchEvent({ status: 'upheld' }, null)),
    ).rejects.toMatchObject({ status: 401 })
    expect(h.decideChallenge).not.toHaveBeenCalled()
  })

  it("(f) admin PATCH status→'upheld' with decision_note → 200", async () => {
    const res = await PATCH(
      patchEvent({ status: 'upheld', decision_note: 'Frist war tatsächlich verletzt' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.challenge).toMatchObject({
      id: 'ch-1',
      status: 'upheld',
      decision_note: 'Frist war tatsächlich verletzt',
    })
    expect(h.decideChallenge).toHaveBeenCalledWith({
      challengeId: 'ch-1',
      resolutionId: 'res-1',
      resolvedBy: 'admin-1',
      status: 'upheld',
      decisionNote: 'Frist war tatsächlich verletzt',
    })
  })

  it('invalid disposition status → 400, service never called', async () => {
    await expect(PATCH(patchEvent({ status: 'open' }))).rejects.toMatchObject({ status: 400 })
    expect(h.decideChallenge).not.toHaveBeenCalled()
  })

  it('deciding a challenge that is not open (or unknown) → 404', async () => {
    h.decideChallenge.mockRejectedValueOnce(new ChallengeNotOpenError('ch-1'))
    await expect(PATCH(patchEvent({ status: 'dismissed' }))).rejects.toMatchObject({ status: 404 })
  })
})
