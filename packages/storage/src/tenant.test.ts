// @vitest-environment node
// TASK-117 TDD 2b + 6 — tenant-id allowlist and tenant-prefixed key shape.
import { describe, it, expect } from 'vitest'
import { assertTenantId, assertKeyInTenant, assertHandleInTenant, composeKey } from './tenant.js'
import * as storageIndex from './index.js'
import { TENANT_A } from '../test/support.js'

describe('assertTenantId', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
    ['padded uuid', ` ${TENANT_A}`],
    ['number', 42],
    ['object', { id: TENANT_A }],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['dot-dot', '..'],
    ['dot-dot inside', `${TENANT_A}/..`],
    ['upper-case uuid', TENANT_A.toUpperCase().replace(/1/g, 'A')],
    ['slug-looking', 'stura'],
    ['Default (case)', 'Default'],
    // TASK-042 (Q6, TRD-042 [D R15-2]): the pre-registry literal is retired.
    ['the retired literal default', 'default'],
  ])('rejects %s', (_label, value) => {
    expect(() => assertTenantId(value)).toThrow(/storage: (no|invalid) tenant id/)
  })

  it('accepts a lowercase canonical UUID', () => {
    expect(assertTenantId(TENANT_A)).toBe(TENANT_A)
    expect(assertTenantId('0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9')).toBe('0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9')
  })

  it('exports no legacy default tenant id (TASK-042 Q6)', () => {
    expect(Object.keys(storageIndex)).not.toContain('LEGACY_DEFAULT' + '_TENANT_ID')
  })
})

describe('key shape', () => {
  it('composeKey prefixes the tenant segment and normalises', () => {
    expect(composeKey('t', TENANT_A, 'a/./b//c.pdf')).toBe(`${TENANT_A}/a/b/c.pdf`)
    expect(composeKey('t', TENANT_A, '///lead.pdf')).toBe(`${TENANT_A}/lead.pdf`)
  })

  it('assertKeyInTenant throws when a composed key lacks the tenant segment (put-time S3 check)', () => {
    expect(() => assertKeyInTenant('t', TENANT_A, 'shared/x.pdf')).toThrow(/does not start with the tenant segment/)
    expect(() => assertKeyInTenant('t', TENANT_A, `${TENANT_A}/`)).toThrow(/does not start with the tenant segment/)
    expect(() => assertKeyInTenant('t', TENANT_A, `${TENANT_A}x/y`)).toThrow(/does not start with the tenant segment/)
    expect(() => assertKeyInTenant('t', TENANT_A, `${TENANT_A}/y`)).not.toThrow()
  })

  it('assertHandleInTenant rejects a handle whose tenant id is only a string prefix', () => {
    // "<A>x/..." starts with "<A>" but not "<A>/": a different segment.
    expect(() => assertHandleInTenant('t', TENANT_A, `${TENANT_A}x/y`)).toThrow(/escapes tenant root/)
    expect(() => assertHandleInTenant('t', TENANT_A, 42)).toThrow(/escapes tenant root/)
  })
})
