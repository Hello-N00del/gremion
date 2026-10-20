import { describe, it, expect } from 'vitest'
import { parseCsvMembers } from './csv-import'

describe('parseCsvMembers', () => {
  it('parses valid CSV with name column', () => {
    const csv = `email,name\na@b.de,Anna\nc@d.de,Clara`
    const result = parseCsvMembers(csv)
    expect(result.valid).toHaveLength(2)
    expect(result.valid[0]).toEqual({ email: 'a@b.de', name: 'Anna' })
    expect(result.skipped).toBe(0)
  })

  it('parses CSV without name column', () => {
    const csv = `email\na@b.de\nc@d.de`
    const result = parseCsvMembers(csv)
    expect(result.valid).toHaveLength(2)
    expect(result.valid[0]!.name).toBeNull()
  })

  it('skips rows with invalid email', () => {
    const csv = `email,name\nnot-an-email,Anna\nc@d.de,Clara`
    const result = parseCsvMembers(csv)
    expect(result.valid).toHaveLength(1)
    expect(result.skipped).toBe(1)
  })

  it('deduplicates emails within the file', () => {
    const csv = `email\na@b.de\na@b.de\nc@d.de`
    const result = parseCsvMembers(csv)
    expect(result.valid).toHaveLength(2)
  })

  it('skips empty rows', () => {
    const csv = `email\na@b.de\n\nc@d.de`
    const result = parseCsvMembers(csv)
    expect(result.valid).toHaveLength(2)
    expect(result.skipped).toBe(0) // blank rows don't count as skipped
  })
})
