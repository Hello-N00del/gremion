// The catalogue's pure rules (no database): which capabilities are privileged
// (a grant of one needs a fresh step-up, TRD-090) and the role-inclusion rule,
// including the body-scope rule capability grants share with role grants.
import { describe, expect, it } from 'vitest'
import { CAPABILITIES, isPrivilegedCapability, roleIncludes } from '../../src/authz/catalogue.ts'

describe('privileged capabilities (TRD-090: a capability grant is a step-up grant exactly when the catalogue says so)', () => {
  it('the identity-domain write capabilities and the grant manager are privileged', () => {
    for (const key of ['idt.grant.manage', 'idt.person.manage', 'idt.structure.manage', 'idt.membership.manage']) {
      expect(isPrivilegedCapability(key), key).toBe(true)
    }
  })
  it('a read capability and an unknown key are not', () => {
    expect(isPrivilegedCapability('idt.grant.read')).toBe(false)
    expect(isPrivilegedCapability('idt.body.read')).toBe(false)
    expect(isPrivilegedCapability('no.such.capability')).toBe(false)
  })
  it('every privileged role-carried write the PDP guards is flagged: no idt.*.manage capability is unflagged', () => {
    const unflagged = CAPABILITIES.filter((c) => /^idt\..*\.manage$/.test(c.key) && !c.privileged).map((c) => c.key)
    expect(unflagged).toEqual([])
  })
})

describe('roleIncludes with the scope of the body the grant is made in', () => {
  it('without a scope the rule is the plain inclusion (unchanged)', () => {
    expect(roleIncludes('it_admin', 'capability', 'idt.structure.manage')).toBe(true)
  })
  it('in the verwaltung (customer scope) an it_admin, which grants body roles only, includes no customer-level capability', () => {
    expect(roleIncludes('it_admin', 'capability', 'idt.structure.manage', 'customer')).toBe(false)
    expect(roleIncludes('it_admin', 'capability', 'idt.person.manage', 'customer')).toBe(false)
  })
  it('in the verwaltung a council_admin includes what a customer-level role carries (idt.structure.manage, fin.expense.approve)', () => {
    expect(roleIncludes('council_admin', 'capability', 'idt.structure.manage', 'customer')).toBe(true)
    expect(roleIncludes('council_admin', 'capability', 'fin.expense.approve', 'customer')).toBe(true)
  })
  it('outside the verwaltung (body scope) a body_admin includes what a body-level role carries and nothing else', () => {
    expect(roleIncludes('body_admin', 'capability', 'idt.structure.manage', 'body')).toBe(true)
    expect(roleIncludes('body_admin', 'capability', 'brd.card.own', 'body')).toBe(true)
    expect(roleIncludes('body_admin', 'capability', 'fin.expense.approve', 'body')).toBe(false)
  })
  it('outside the verwaltung a customer-only capability (idt.person.manage) is carried by no body-level role, even for a council_admin', () => {
    expect(roleIncludes('council_admin', 'capability', 'idt.person.manage', 'body')).toBe(false)
  })
  it('a role with grants none includes nothing in any scope', () => {
    expect(roleIncludes('member', 'capability', 'brd.card.own', 'body')).toBe(false)
  })
})
