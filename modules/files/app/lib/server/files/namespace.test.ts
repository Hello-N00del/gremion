import { describe, it, expect } from 'vitest'
import { tenantKey, unitMountPoint, unitGroupId, mountSuffix, plainMountName } from './namespace'

// The key of a customer is a hash of its tenant id, NOT a prefix: tenant ids are time-ordered, so a prefix
// of two customers created close together would nearly agree. The same vector is asserted by the host
// script's bats file (test/host/files-namespace.bats), which derives it with sha256sum.
const TENANT_A = '01a2132e-7c11-7a3d-8b2e-4f5a6b7c8d9e'
const TENANT_B = '0192f0c4-0000-7000-8000-000000000002'

describe('files namespace', () => {
  it('derives a short, stable key from the tenant id (sha256, first 10 hex digits)', () => {
    expect(tenantKey(TENANT_A)).toBe('cfe3ee6357')
    expect(tenantKey(TENANT_B)).toBe('f6ddcbee9b')
    expect(tenantKey(TENANT_A)).toBe(tenantKey(TENANT_A))
  })

  it('does not depend on the letter case of the tenant id', () => {
    expect(tenantKey(TENANT_A.toUpperCase())).toBe(tenantKey(TENANT_A))
  })

  it('refuses an empty tenant id: an unnamed customer must never get a key', () => {
    expect(() => tenantKey('')).toThrow('empty tenant id')
  })

  it('builds the mount point as "<unit name> (<key>)": the plain name stays readable, the key makes it unique', () => {
    expect(unitMountPoint('cfe3ee6357', 'Vorstand')).toBe('Vorstand (cfe3ee6357)')
    expect(mountSuffix('cfe3ee6357')).toBe(' (cfe3ee6357)')
  })

  it('builds the Nextcloud group id from the key and the unit id, within the 64 characters Nextcloud allows', () => {
    const id = unitGroupId('cfe3ee6357', '0192f0c4-1111-7000-8000-000000000001')
    expect(id).toBe('ou-cfe3ee6357-0192f0c4-1111-7000-8000-000000000001')
    expect(id.length).toBeLessThanOrEqual(64)
  })

  it('shows the plain name: strips this customer\'s key from a mount point and nothing else', () => {
    expect(plainMountName('cfe3ee6357', 'Vorstand (cfe3ee6357)')).toBe('Vorstand')
    expect(plainMountName('cfe3ee6357', 'Vorstand')).toBe('Vorstand') // a folder from before the namespace
    expect(plainMountName('cfe3ee6357', 'Vorstand (f6ddcbee9b)')).toBe('Vorstand (f6ddcbee9b)') // not this customer's key
    expect(plainMountName('cfe3ee6357', 'Sitzung (2026) (cfe3ee6357)')).toBe('Sitzung (2026)')
  })
})
