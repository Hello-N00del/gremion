import { describe, it, expect, test } from 'vitest'
import { hasRole, canAccess, Role, PAGE_ACCESS } from '$lib/auth'

describe('hasRole', () => {
  it('returns true when user has the exact role', () => {
    const roles = [Role.Member, Role.CouncilAdmin]
    expect(hasRole(roles, Role.CouncilAdmin)).toBe(true)
  })

  it('returns false when user lacks the role', () => {
    const roles = [Role.Member]
    expect(hasRole(roles, Role.CouncilAdmin)).toBe(false)
  })

  it('it-admin implicitly has all roles', () => {
    const roles = [Role.ITAdmin]
    expect(hasRole(roles, Role.Member)).toBe(true)
  })

  it('it-admin implicitly has council-admin role', () => {
    const roles = [Role.ITAdmin]
    expect(hasRole(roles, Role.CouncilAdmin)).toBe(true)
  })

  it('council-admin implicitly has member role', () => {
    const roles = [Role.CouncilAdmin]
    expect(hasRole(roles, Role.Member)).toBe(true)
  })
})

describe('canAccess (legacy smoke tests)', () => {
  it('guest cannot access members', () => {
    expect(canAccess([Role.Guest], 'members')).toBe(false)
  })

  it('member can access members', () => {
    expect(canAccess([Role.Member], 'members')).toBe(true)
  })

  it('guest can access committees (council structure is transparent)', () => {
    expect(canAccess([Role.Guest], 'committees')).toBe(true)
  })

  it('member can access settings (#167: Konto sections)', () => {
    // #167: PAGE_ACCESS.settings is Role.Member — every signed-in member reaches
    // /settings and sees the "Konto" sections (Profil + Darstellung). The
    // Verwaltung/System sections are gated INSIDE the page by data.isITAdmin, and
    // every /api/settings* endpoint keeps its own it-admin gate.
    expect(canAccess([Role.Member], 'settings')).toBe(true)
  })

  it('it-admin can access settings', () => {
    expect(canAccess([Role.ITAdmin], 'settings')).toBe(true)
  })

  it('throws in dev mode for an unknown page key (G-072: build-time + runtime guard)', () => {
    // G-072 changed the contract: under `import.meta.env.DEV`, an unknown
    // page segment is a programmer error (a route added without a matching
    // PAGE_ACCESS entry) and throws loudly. Production behaviour
    // (silent-deny) is unchanged and is covered by the comment in
    // src/lib/auth/index.ts — vitest always runs with DEV=true so we cannot
    // exercise the prod branch from here without mocking import.meta.env,
    // which would be more fragile than the comment.
    expect(import.meta.env.DEV).toBe(true)
    expect(() => canAccess([Role.ITAdmin], 'nonexistent-page')).toThrow(
      /PAGE_ACCESS missing for: nonexistent-page/,
    )
  })
})

/*
 * G-065 — exhaustive PAGE_ACCESS coverage.
 *
 * For every entry in PAGE_ACCESS we assert one role that MUST be granted
 * access and one role state that MUST be denied. The data tables below
 * are the source of truth for "what passes vs fails per required role";
 * the auto-enumeration guard at the bottom of this block verifies that
 * every page in the production map has at least one positive AND one
 * negative case here. Adding a new page to PAGE_ACCESS without
 * extending the tables will fail CI.
 */
describe('canAccess — exhaustive PAGE_ACCESS coverage (G-065)', () => {
  // Per required role: roles that MUST grant access (positive matrix). The
  // governance-only kernel role ladder is guest < member < council-admin <
  // it-admin (the finance/auditor roles were carved out with their module).
  const POSITIVE_ROLES_FOR: Record<Role, Role[]> = {
    [Role.Guest]: [Role.Guest, Role.Member, Role.CouncilAdmin, Role.ITAdmin],
    [Role.Member]: [Role.Member, Role.CouncilAdmin, Role.ITAdmin],
    [Role.CouncilAdmin]: [Role.CouncilAdmin, Role.ITAdmin],
    [Role.ITAdmin]: [Role.ITAdmin],
  }

  // Per required role: role states that MUST be denied (negative matrix).
  // For Role.Guest the only way to be denied is to hold no roles at all.
  const NEGATIVE_ROLES_FOR: Record<Role, Role[][]> = {
    [Role.Guest]: [[]],
    [Role.Member]: [[], [Role.Guest]],
    [Role.CouncilAdmin]: [[], [Role.Guest], [Role.Member]],
    [Role.ITAdmin]: [[], [Role.Guest], [Role.Member], [Role.CouncilAdmin]],
  }

  // Build the parametrised test cases at collection time.
  type PositiveCase = { page: string; required: Role; userRoles: Role[] }
  type NegativeCase = { page: string; required: Role; userRoles: Role[] }

  const positiveCases: PositiveCase[] = []
  const negativeCases: NegativeCase[] = []

  for (const [page, required] of Object.entries(PAGE_ACCESS)) {
    for (const userRole of POSITIVE_ROLES_FOR[required] ?? []) {
      positiveCases.push({ page, required, userRoles: [userRole] })
    }
    for (const userRoles of NEGATIVE_ROLES_FOR[required] ?? []) {
      negativeCases.push({ page, required, userRoles })
    }
  }

  // Coverage sets computed from the generated cases (collection-time,
  // not runtime). The guard below uses these to detect any PAGE_ACCESS
  // entry that produced zero positive or zero negative test cases.
  const positiveCovered = new Set(positiveCases.map((c) => c.page))
  const negativeCovered = new Set(negativeCases.map((c) => c.page))

  test.each(positiveCases)(
    'positive: page=$page required=$required → roles=[$userRoles] passes',
    ({ page, userRoles }) => {
      expect(canAccess(userRoles, page)).toBe(true)
    }
  )

  test.each(negativeCases)(
    'negative: page=$page required=$required → roles=[$userRoles] fails',
    ({ page, userRoles }) => {
      expect(canAccess(userRoles, page)).toBe(false)
    }
  )

  /*
   * Auto-enumeration guard. Iterates Object.entries(PAGE_ACCESS) and
   * asserts each page produced at least one positive AND one negative
   * generated case. If a new page is added to PAGE_ACCESS with a
   * required role that POSITIVE_ROLES_FOR / NEGATIVE_ROLES_FOR don't
   * cover, no cases are generated for it and this guard fails CI.
   */
  describe('auto-enumeration guard', () => {
    test.each(Object.entries(PAGE_ACCESS))(
      'page "%s" (required=%s) has at least one positive AND one negative test case',
      (page, required) => {
        expect(
          POSITIVE_ROLES_FOR[required],
          `PAGE_ACCESS entry "${page}" requires role "${required}" but POSITIVE_ROLES_FOR has no entry for that role. ` +
            `Update POSITIVE_ROLES_FOR / NEGATIVE_ROLES_FOR to cover the new role.`
        ).toBeDefined()
        expect(
          NEGATIVE_ROLES_FOR[required],
          `PAGE_ACCESS entry "${page}" requires role "${required}" but NEGATIVE_ROLES_FOR has no entry for that role.`
        ).toBeDefined()
        expect(
          positiveCovered.has(page),
          `PAGE_ACCESS entry "${page}" has no positive test coverage. ` +
            `Extend POSITIVE_ROLES_FOR for required role "${required}".`
        ).toBe(true)
        expect(
          negativeCovered.has(page),
          `PAGE_ACCESS entry "${page}" has no negative test coverage. ` +
            `Extend NEGATIVE_ROLES_FOR for required role "${required}".`
        ).toBe(true)
      }
    )

    it('PAGE_ACCESS is not empty (sanity)', () => {
      expect(Object.keys(PAGE_ACCESS).length).toBeGreaterThan(0)
    })
  })
})
