import { describe, expect, it } from 'vitest'
import { folderNameProblem } from './folder-name'

describe('folderNameProblem', () => {
  it.each(['Protokolle', 'Sitzung 2026-11-25', 'a..b', '.hidden', 'Ä Ö Ü', 'v1.2'])('lets %j through', (name) => {
    expect(folderNameProblem(name)).toBeNull()
  })
  it.each(['', '   ', '\t'])('refuses the empty name %j', (name) => {
    expect(folderNameProblem(name)).toBe('empty')
  })
  it.each(['a/b', '../x', '/etc', 'a\\b', '..\\x', 'x/'])('refuses the path separator in %j', (name) => {
    expect(folderNameProblem(name)).toBe('separator')
  })
  it.each(['..', '.', ' .. ', '. ', '..?x', '..#x', '.. #y'])('refuses the dot name %j', (name) => {
    expect(folderNameProblem(name)).toBe('dots')
  })
  it.each(['a\nb', 'a\u0000b', 'a\u007fb'])('refuses a control character in %j', (name) => {
    expect(folderNameProblem(name)).toBe('characters')
  })
})
