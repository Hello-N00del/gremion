export interface CsvMember {
  email: string
  name: string | null
}

export interface CsvParseResult {
  valid: CsvMember[]
  skipped: number
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function parseCsvMembers(csvText: string): CsvParseResult {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim())
  if (lines.length === 0) return { valid: [], skipped: 0 }

  const header = lines[0]!.toLowerCase().split(',').map((h) => h.trim())
  const emailCol = header.indexOf('email')
  const nameCol = header.indexOf('name')

  if (emailCol === -1) return { valid: [], skipped: 0 }

  const seen = new Set<string>()
  const valid: CsvMember[] = []
  let skipped = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (!line) continue
    const cols = line.split(',').map((c) => c.trim())
    const email = cols[emailCol]?.toLowerCase() ?? ''
    if (!EMAIL_REGEX.test(email)) {
      skipped++
      continue
    }
    if (seen.has(email)) continue
    seen.add(email)
    const name = nameCol !== -1 ? (cols[nameCol] ?? null) : null
    valid.push({ email, name: name || null })
  }

  return { valid, skipped }
}
