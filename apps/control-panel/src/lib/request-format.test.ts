import { describe, expect, it } from 'vitest'
import { originLabel } from './request-format'

describe('originLabel (A8)', () => {
  it('flags a host-origin request as Break-glass and a panel one as Panel', () => {
    expect(originLabel('host')).toBe('Break-glass')
    expect(originLabel('panel')).toBe('Panel')
  })
})
