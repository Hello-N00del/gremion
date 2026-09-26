// TASK-009 kernel lane (F1 drift): the kernel's own /protokolle aggregate
// list has the SAME defect the product (gremion-ui/StuRaOS) /protocols page
// had before TASK-009 lane A fixed it there (c33778d6) — no isAdmin in the
// load, so no row can be gated to an editor link. Mirrors
// protocols-admin-link.test.ts's load-side cases: isAdmin is derived the
// same way as the sibling /committees loader AND the exact permission the
// per-committee protocol editor page itself enforces for writes
// (Role.CouncilAdmin — see
// members/committees/[id]/protokolle/[protocolId]/+page.svelte's own
// `isAdmin = hasRole(user.roles, Role.CouncilAdmin)` gate). This never
// widens access: a non-admin reaching the editor route directly still only
// gets the read view that route already allows.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { listProtocols } = vi.hoisted(() => ({ listProtocols: vi.fn() }))
vi.mock('$lib/server/governance/protocols-db', () => ({ listProtocols }))

import { load } from './+page.server'

beforeEach(() => {
  listProtocols.mockReset()
  listProtocols.mockResolvedValue([])
})

type LoadResult = { protocols: unknown[]; isAdmin: boolean }

describe('/protokolle load — isAdmin for editor-link discoverability (kernel F1 drift)', () => {
  it('reports isAdmin=true for a council-admin session', async () => {
    const ev = { locals: { user: { roles: ['council-admin'] } } } as unknown as Parameters<typeof load>[0]
    const result = (await load(ev)) as LoadResult
    expect(result.isAdmin).toBe(true)
  })

  it('reports isAdmin=true for an it-admin session (role hierarchy implies council-admin)', async () => {
    const ev = { locals: { user: { roles: ['it-admin'] } } } as unknown as Parameters<typeof load>[0]
    const result = (await load(ev)) as LoadResult
    expect(result.isAdmin).toBe(true)
  })

  it('reports isAdmin=false for a plain member session', async () => {
    const ev = { locals: { user: { roles: ['member'] } } } as unknown as Parameters<typeof load>[0]
    const result = (await load(ev)) as LoadResult
    expect(result.isAdmin).toBe(false)
  })

  it('reports isAdmin=false with no session at all (guest)', async () => {
    const ev = {} as unknown as Parameters<typeof load>[0]
    const result = (await load(ev)) as LoadResult
    expect(result.isAdmin).toBe(false)
  })
})
