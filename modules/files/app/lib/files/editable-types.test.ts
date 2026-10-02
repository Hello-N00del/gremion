import { describe, it, expect } from 'vitest'
import * as editableTypes from './editable-types'
import { isEditableFile, isViewableFile, getFileExtension, EDITABLE_EXTENSIONS, VIEWABLE_EXTENSIONS } from './editable-types'

// Read through the namespace so the file still compiles (and fails as a test,
// not as an import error) on a build without the helper.
const fileResponseContentType = (name: string): string | undefined =>
  (editableTypes as { fileResponseContentType?: (n: string) => string }).fileResponseContentType?.(name)

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
  it.each(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md'])(
    'returns true for %s',
    (ext) => {
      expect(isViewableFile('file' + ext)).toBe(true)
    }
  )

  // F1-FIX-03 / H17: an SVG is a document that can carry <script>; opened
  // inline from the app origin it ran with the viewer's session.
  it.each(['.odt', '.docx', '.ods', '.odp', '.zip', '.exe', '.svg', '.SVG', '.html', '.xml'])(
    'returns false for %s',
    (ext) => {
      expect(isViewableFile('file' + ext)).toBe(false)
    }
  )

  it('VIEWABLE_EXTENSIONS contains exactly 8 types (no .svg)', () => {
    expect(VIEWABLE_EXTENSIONS.size).toBe(8)
    expect(VIEWABLE_EXTENSIONS.has('.svg')).toBe(false)
  })
})

describe('fileResponseContentType (H17: a fixed type per extension, never the upstream one)', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['a.PNG', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.txt', 'text/plain; charset=utf-8'],
    ['a.md', 'text/plain; charset=utf-8'],
    ['a.svg', 'application/octet-stream'],
    ['a.html', 'application/octet-stream'],
    ['a.odt', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('%s -> %s', (name, type) => {
    expect(fileResponseContentType(name)).toBe(type)
  })

  it('every viewable extension has a fixed type that is not HTML, XML or SVG', () => {
    for (const ext of VIEWABLE_EXTENSIONS) {
      expect(fileResponseContentType('f' + ext)).not.toMatch(/html|xml|svg/i)
    }
  })
})
