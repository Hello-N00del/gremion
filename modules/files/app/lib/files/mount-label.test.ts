import { describe, expect, it } from 'vitest'
import { stripMountSuffix } from './mount-label'

// A group folder's mount point carries its customer's key (" (<key>)"); members are shown the plain unit name.
describe('stripMountSuffix', () => {
  it('removes the customer key from the end of a mount point', () => {
    expect(stripMountSuffix('Vorstand (1efb7da1c9)', ' (1efb7da1c9)')).toBe('Vorstand')
  })

  it('leaves a name without the key as it is (a folder made before the namespace, or a plain subfolder)', () => {
    expect(stripMountSuffix('Vorstand', ' (1efb7da1c9)')).toBe('Vorstand')
    expect(stripMountSuffix('Sitzung (2026)', ' (1efb7da1c9)')).toBe('Sitzung (2026)')
  })

  it("leaves another customer's key alone: it is never this customer's to hide", () => {
    expect(stripMountSuffix('Vorstand (f6ddcbee9b)', ' (1efb7da1c9)')).toBe('Vorstand (f6ddcbee9b)')
  })

  it('does nothing without a suffix, and never returns an empty name', () => {
    expect(stripMountSuffix('Vorstand', '')).toBe('Vorstand')
    expect(stripMountSuffix(' (1efb7da1c9)', ' (1efb7da1c9)')).toBe(' (1efb7da1c9)')
  })
})
