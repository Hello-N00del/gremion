import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isHiddenGroup,
  isHiddenRole,
  scopeLabel,
  scopeLabels,
  roleLabel,
  roleLabels,
} from './labels'

describe('isHiddenGroup', () => {
  test('mitglied is plumbing', () => {
    expect(isHiddenGroup('mitglied')).toBe(true)
  })
  test('real groups are not hidden', () => {
    expect(isHiddenGroup('admin')).toBe(false)
    expect(isHiddenGroup('it-admin')).toBe(false)
  })
})

describe('isHiddenRole', () => {
  test.each(['offline_access', 'uma_authorization', 'default-roles-gremion'])(
    '%s is infra noise',
    (r) => expect(isHiddenRole(r)).toBe(true),
  )
  test('real roles are not hidden', () => {
    expect(isHiddenRole('council-admin')).toBe(false)
    expect(isHiddenRole('it-admin')).toBe(false)
  })
})

describe('scopeLabel', () => {
  test('hidden group → null (never shown)', () => {
    expect(scopeLabel('mitglied')).toBeNull()
  })
  test('admin groups → admin-kind label', () => {
    expect(scopeLabel('admin')).toEqual({ label: 'Administration', kind: 'admin' })
    expect(scopeLabel('it-admin')).toEqual({ label: 'IT-Administration', kind: 'admin' })
  })
  test('unknown group degrades visibly to raw id with other kind', () => {
    expect(scopeLabel('ref-neu')).toEqual({ label: 'ref-neu', kind: 'other' })
  })
})

describe('scopeLabels', () => {
  test('drops mitglied, keeps the meaningful scopes', () => {
    expect(scopeLabels(['mitglied', 'admin', 'it-admin'])).toEqual([
      { label: 'Administration', kind: 'admin' },
      { label: 'IT-Administration', kind: 'admin' },
    ])
  })
  test('member with only mitglied has no scope chips', () => {
    expect(scopeLabels(['mitglied'])).toEqual([])
  })
})

describe('roleLabel / roleLabels', () => {
  test('friendly German role labels', () => {
    expect(roleLabel('member')).toBe('Mitglied')
    expect(roleLabel('council-admin')).toBe('Gremienverwaltung')
    expect(roleLabel('it-admin')).toBe('IT-Administration')
  })
  test('unknown role degrades to raw id', () => {
    expect(roleLabel('referent')).toBe('referent')
  })
  test('roleLabels drops infra roles and maps the rest', () => {
    expect(roleLabels(['default-roles-gremion', 'offline_access', 'council-admin', 'member'])).toEqual([
      'Gremienverwaltung',
      'Mitglied',
    ])
  })
})

// ── Kernel is governance-only: no finance vocabulary in the label seam ──────
//
// GUARD (kernel carve). labels.ts is $lib/auth — kernel, always compiled in.
// It used to hard-code the finance module's vocabulary: a `'finance'` member of
// the ScopeKind union, four `ref-finanzen*` GROUP_LABELS entries and a
// `finance` ROLE_LABELS entry. Those belong to the finance FEATURE MODULE
// (git-rm'd from this repo in the open-core carve), not to the governance
// kernel. Asserted against the file's own source because the leak is the
// PRESENCE of the vocabulary, which a behavioural call cannot observe: with the
// entries gone, `scopeLabel('ref-finanzen')` returns the identical
// `{ label: 'ref-finanzen', kind: 'other' }` fallback that any unknown group
// gets, so no runtime assertion can distinguish "removed" from "never there".
//
// A module that re-introduces finance labels must do it in its OWN manifest
// (see $lib/modules/manifests/*), never here.
describe('labels.ts carries no finance-module vocabulary (kernel carve)', () => {
  // process.cwd() is gremion-ui/ when vitest runs (same convention as
  // brand.guard.test.ts); import.meta.url is not a file: URL under vitest.
  const SRC = readFileSync(resolve(process.cwd(), 'src/lib/auth/labels.ts'), 'utf8')

  test('the source file is actually loaded (a zero-byte read would vacuously pass)', () => {
    expect(SRC.length).toBeGreaterThan(500)
    expect(SRC).toContain('export type ScopeKind')
  })

  test.each(['ref-finanzen', 'Kassenverwaltung', 'Haushaltsverantwortung', 'Finanzen', 'Belege'])(
    'no %s literal',
    (needle) => expect(SRC).not.toContain(needle),
  )

  test("ScopeKind has no 'finance' member", () => {
    const union = SRC.match(/export type ScopeKind\s*=\s*([^\n]+)/)?.[1] ?? ''
    expect(union).not.toContain('finance')
    // ...and the union is still non-empty, so the check is not vacuous.
    expect(union).toContain('admin')
  })

  test('GROUP_LABELS and ROLE_LABELS carry no finance entry', () => {
    expect(SRC).not.toMatch(/\bfinance\b/)
  })

  test('the remaining governance labels are still there', () => {
    expect(SRC).toContain("admin: { label: 'Administration'")
    expect(SRC).toContain("'council-admin': 'Gremienverwaltung'")
  })
})
