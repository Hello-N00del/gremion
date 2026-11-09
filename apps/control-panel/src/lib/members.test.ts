// The pure half of the customer page's "Vertikale und Mitglieder" section:
// the verticals the panel can name, the size caps (mirrors of the provisioning
// package, pinned equal by reading its source: the panel image has no such
// dependency), and the validate summary read back from a request's events.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IMPORT_LIST_MAX_BYTES, IMPORT_PAYLOAD_MAX_BYTES, isKnownVertical, parseImportSummary, redactAddresses, SUMMARY_LINE, VERTICALS, VERTICAL_ID } from './members'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/provisioning/src/requests.ts')
const SHA = 'a'.repeat(64)

describe('mirrors of @gremion/provisioning (read from its source)', () => {
  const src = readFileSync(SRC, 'utf8')
  it('the member list cap is the package IMPORT_LIST_MAX_BYTES', () => {
    const m = /export const IMPORT_LIST_MAX_BYTES = ([\d_]+)/.exec(src)?.[1] ?? ''
    expect(IMPORT_LIST_MAX_BYTES).toBe(Number(m.replaceAll('_', '')))
  })
  it('the payload cap is the one of platform migration 0010 (1.5 MiB)', () => {
    const sql = readFileSync(join(dirname(SRC), '../../tenant-store/src/lifecycle/platform-migrations/0010_plt_request_payload.sql'), 'utf8')
    expect(sql).toContain(`THEN ${IMPORT_PAYLOAD_MAX_BYTES} ELSE`)
  })
  it('the vertical id pattern is the package VERTICAL_ID', () => {
    const m = /const VERTICAL_ID = \/(.*)\/\r?$/m.exec(src)?.[1] ?? ''
    expect(VERTICAL_ID.source).toBe(m)
  })
})

describe('the verticals the panel can name', () => {
  it('starts with stura, and every entry is a valid vertical id', () => {
    expect(VERTICALS.map((v) => v.id)).toContain('stura')
    for (const v of VERTICALS) expect(v.id).toMatch(VERTICAL_ID)
  })
  it('isKnownVertical accepts only the listed ids', () => {
    expect(isKnownVertical('stura')).toBe(true)
    for (const v of ['', 'Stura', 'stura ', 'nosuch', 'stura;ls', '-x']) expect(isKnownVertical(v)).toBe(false)
  })
})

describe('parseImportSummary: the validate line the host handler writes', () => {
  const line = () => ({
    level: 'info',
    step: 'validate',
    // the parser reads every count the handler line carries, though a validate line only has a real rejected count
    message: `import validate: status=validated sha256=${SHA} created=12 linked_existing=3 unchanged=1 rejected=0 accounts_created=0 invites_sent=0`,
  })
  it('reads the status, the sha256 and every count', () => {
    expect(parseImportSummary([{ level: 'info', step: 'claim', message: 'claimed' }, line()])).toEqual({
      status: 'validated',
      sha256: SHA,
      counts: { created: 12, linkedExisting: 3, unchanged: 1, rejected: 0, accountsCreated: 0, invitesSent: 0 },
    })
  })
  it('a list that did not validate is a summary with status rejected (the caller offers no apply for it)', () => {
    const s = parseImportSummary([{ level: 'info', step: 'validate', message: `import validate: status=rejected sha256=${SHA} created=0 linked_existing=0 unchanged=0 rejected=4 accounts_created=0 invites_sent=0` }])
    expect(s).toMatchObject({ status: 'rejected', counts: { rejected: 4 } })
  })
  it('no summary line, a malformed sha256 or a non-number count is null (never a half-read apply)', () => {
    expect(parseImportSummary([])).toBeNull()
    expect(parseImportSummary([{ level: 'info', step: 'x', message: 'hello' }])).toBeNull()
    expect(parseImportSummary([{ level: 'info', step: 'validate', message: line().message.replace(SHA, 'abc') }])).toBeNull()
    expect(parseImportSummary([{ level: 'info', step: 'validate', message: line().message.replace('created=12', 'created=x') }])).toBeNull()
  })
  it('an apply or rerun line is not a validate summary', () => {
    expect(parseImportSummary([{ level: 'info', step: 'apply', message: line().message.replace('import validate:', 'import apply:') }])).toBeNull()
  })
})

describe('SUMMARY_LINE is pinned to the handler that writes the line (read from its source)', () => {
  const sh = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../infra/host/lib/executor/handlers/import_members.sh'), 'utf8')
  const template = sh.split(/\r?\n/).find((l) => l.includes('import \\($p): status='))
  it('the handler writes one summary line with the fields, in the order, that the panel parses', () => {
    expect(template).toBeTruthy()
    const handlerFields = [...(template ?? '').matchAll(/\b([a-z0-9_]+)=\\\(/g)].map((m) => m[1])
    const panelFields = [...SUMMARY_LINE.source.matchAll(/\b([a-z0-9_]+)=\(/g)].map((m) => m[1])
    expect(handlerFields).toEqual(['status', 'sha256', 'created', 'linked_existing', 'unchanged', 'rejected', 'accounts_created', 'invites_sent'])
    expect(panelFields).toEqual(handlerFields)
  })
  it('a line built from the handler template parses', () => {
    const fields = [...(template ?? '').matchAll(/\b([a-z0-9_]+)=\\\(/g)].map((m) => m[1]!)
    const values: Record<string, string> = { status: 'validated', sha256: SHA }
    const line = `import validate: ${fields.map((f) => `${f}=${values[f] ?? '0'}`).join(' ')}`
    expect(parseImportSummary([{ level: 'info', step: 'validate', message: line }])).toMatchObject({ status: 'validated', sha256: SHA })
  })
})

describe('redactAddresses: a second net before event text is drawn', () => {
  it('replaces every token carrying an @ or %40', () => {
    expect(redactAddresses('row 3: x@example.org and y%40example.org differ')).toBe('row 3: [address] and [address] differ')
  })
  it('leaves row numbers and reason codes alone', () => {
    expect(redactAddresses('  row 7: duplicate_email')).toBe('  row 7: duplicate_email')
  })
})

describe('the upload reaches the action: the node adapter body limit (default 512 kB) is raised in the image', () => {
  const docker = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../Dockerfile'), 'utf8')
  /** adapter-node: a plain number of bytes or a number with K, M or G (1024-based). */
  const bytes = (v: string): number => {
    const m = /^(\d+)([KMG]?)$/.exec(v)
    return m ? Number(m[1]) * ({ '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 } as Record<string, number>)[m[2]!]! : 0
  }
  it('BODY_SIZE_LIMIT in the Dockerfile ENV holds a list at the cap plus the form fields, and stays well below 16 MiB', () => {
    const v = /^\s*BODY_SIZE_LIMIT=(\S+?)\s*(?:\\)?\s*$/m.exec(docker)?.[1] ?? ''
    expect(bytes(v)).toBeGreaterThanOrEqual(IMPORT_LIST_MAX_BYTES + 64 * 1024)
    expect(bytes(v)).toBeLessThanOrEqual(16 * 1024 * 1024)
  })
})