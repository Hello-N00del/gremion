import { describe, expect, it } from 'vitest'
import { clampPosition } from './draggable'

describe('clampPosition', () => {
  it('keeps position inside viewport when within bounds', () => {
    const pos = clampPosition({ x: 100, y: 100 }, 300, 200, 1920, 1080)
    expect(pos).toEqual({ x: 100, y: 100 })
  })

  it('clamps x to maximum right distance when element would overflow right edge', () => {
    const pos = clampPosition({ x: 1700, y: 100 }, 300, 200, 1920, 1080)
    expect(pos.x).toBeLessThanOrEqual(1920 - 300 - 8)
  })

  it('clamps y to maximum bottom distance when element would overflow bottom', () => {
    const pos = clampPosition({ x: 100, y: 900 }, 300, 200, 1920, 1080)
    expect(pos.y).toBeLessThanOrEqual(1080 - 200 - 8)
  })

  it('enforces minimum margin of 8px from viewport edges', () => {
    const pos = clampPosition({ x: -50, y: -50 }, 300, 200, 1920, 1080)
    expect(pos.x).toBeGreaterThanOrEqual(8)
    expect(pos.y).toBeGreaterThanOrEqual(8)
  })

  it('respects custom margin', () => {
    const pos = clampPosition({ x: 0, y: 0 }, 300, 200, 1920, 1080, 16)
    expect(pos.x).toBe(16)
    expect(pos.y).toBe(16)
  })
})
