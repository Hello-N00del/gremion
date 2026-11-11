// Karenz / B3: which direct config.modules writes are refused as an off-to-on switch.
import { describe, expect, it } from 'vitest'
import { councilSwitchEnablesIn } from './direct-writes'

describe('councilSwitchEnablesIn', () => {
  it('a council-switchable module that is off may not be written on', () => {
    expect(councilSwitchEnablesIn({ votes: true }, { votes: false })).toEqual(['votes'])
  })

  it('a module the council cannot switch and the platform does not hold off is a plain config write', () => {
    expect(councilSwitchEnablesIn({ board: true }, { board: false })).toEqual([])
  })

  it('a module the platform holds off may not be written on, switchable or not', () => {
    expect(councilSwitchEnablesIn({ board: true }, { board: false }, ['board'])).toEqual(['board'])
  })

  it('writing a platform-held module off, or leaving it as it is, is not refused', () => {
    expect(councilSwitchEnablesIn({ board: false }, { board: false }, ['board'])).toEqual([])
    expect(councilSwitchEnablesIn({ board: true }, { board: true }, ['board'])).toEqual([])
    expect(councilSwitchEnablesIn({ files: true }, { files: false }, ['board'])).toEqual([])
  })
})
