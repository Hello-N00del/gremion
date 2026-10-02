import { describe, it, expect } from 'vitest'
import { isEditableFile, isViewableFile, getFileExtension, EDITABLE_EXTENSIONS, VIEWABLE_EXTENSIONS } from './editable-types'

describe('getFileExtension', () => {
  it('returns lowercase extension with dot', () => {
    expect(getFileExtension('Protokoll.ODT')).toBe('.odt')
    expect(getFileExtension('budget.DOCX')).toBe('.docx')
    expect(getFileExtension('notes.md')).toBe('.md')
  })

  it('returns empty string for files without extension', () => {
    expect(getFileExtension('Dockerfile')).toBe('')
    expect(getFileExtension('')).toBe('')
  })
})

describe('isEditableFile', () => {
  it.each(['.odt', '.docx', '.ods', '.odp', '.pdf'])('returns true for %s', (ext) => {
    expect(isEditableFile('document' + ext)).toBe(true)
  })

  it('returns false for .md (not supported by Collabora)', () => {
    expect(isEditableFile('notes.md')).toBe(false)
  })

  it.each(['.zip', '.png', '.mp4', '.exe'])('returns false for %s', (ext) => {
    expect(isEditableFile('file' + ext)).toBe(false)
  })

  it('returns false for directories (no extension)', () => {
    expect(isEditableFile('Ordner')).toBe(false)
  })

  it('EDITABLE_EXTENSIONS contains exactly 5 types', () => {
    expect(EDITABLE_EXTENSIONS.size).toBe(5)
  })
})

describe('isViewableFile', () => {
  it.each(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.txt', '.md'])(
    'returns true for %s',
    (ext) => {
      expect(isViewableFile('file' + ext)).toBe(true)
    }
  )

  it.each(['.odt', '.docx', '.ods', '.odp', '.zip', '.exe'])('returns false for %s', (ext) => {
    expect(isViewableFile('file' + ext)).toBe(false)
  })

  it('VIEWABLE_EXTENSIONS contains exactly 9 types', () => {
    expect(VIEWABLE_EXTENSIONS.size).toBe(9)
  })
})
