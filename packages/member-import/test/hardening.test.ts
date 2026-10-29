// TASK-031 fix round (house review, 4 Opus lenses): what a list may leak into
// an error, what Keycloak 26 would refuse mid-apply, and the lease heartbeat.
import { describe, expect, it } from 'vitest'
import {
  applyImport,
  ImportApplyError,
  isPlausibleEmail,
  parseList,
  redactAddresses,
  validateList,
  validateRows,
  ListFormatError,
  type RawRow,
} from '../src/index.ts'
import { BODIES, FakeTarget, fixtureVertical } from './helpers.ts'

const HEADER = 'name,email,body,role\n'
const ctx = () => ({ bodies: BODIES, roles: fixtureVertical().roles })
const one = (name: string, email: string): RawRow => ({ row: 2, name, email, body: 'Assembly', role: '' })

describe('csv bad_header never echoes a cell (finding 2)', () => {
  const headerless = 'Anna Berger,anna.berger@example.org,Assembly,member\nBen Hoffmann,ben@example.org,Assembly,\n'

  it('a headerless list: the error names the column count and the missing columns, no cell value, no address', () => {
    let err: unknown
    try {
      parseList(headerless)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ListFormatError)
    const msg = (err as ListFormatError).message
    expect((err as ListFormatError).code).toBe('bad_header')
    expect(msg).not.toMatch(/@/)
    expect(msg).not.toMatch(/anna|berger|ben|hoffmann|example|assembly/i)
    expect(msg).toMatch(/4 columns/)
    expect(msg).toMatch(/missing: name, email, body/)
  })

  it('a single-word headerless first row (a name alone) is not echoed either', () => {
    expect(() => parseList('Anna,Berger\nBen,Hoffmann\n')).toThrow(/2 columns/)
    expect(() => parseList('Anna,Berger\nBen,Hoffmann\n')).not.toThrow(/anna|berger/i)
  })

  it('a repeated known column is named; the unknown ones are only counted', () => {
    expect(() => parseList('name,name,email,body\n')).toThrow(/repeated: name/)
    expect(() => parseList('name,email,body,colour\n')).toThrow(/1 unknown/)
  })
})

describe('validate mirrors the Keycloak 26 default user profile (finding 5)', () => {
  const reasonOf = (name: string, email = 'ok@x.example') => validateRows([one(name, email)], ctx()).rejected[0]?.reason

  it.each(['(', ')', '<', '>', '&', '"', '$', '%', '!', '#', '?', ';', '*', '~', '/', '\\', '|', '^', '=', '[', ']', '{', '}', '§'])(
    'a name containing %s is rejected with the name reason (not applied)',
    (ch) => {
      expect(reasonOf(`Anna ${ch}Berger`)).toBe('malformed_email')
    },
  )

  it('a control character in a name is rejected', () => {
    expect(reasonOf('Anna\u0007Berger')).toBe('malformed_email')
    expect(reasonOf('Anna\u0000Berger')).toBe('malformed_email')
  })

  it('ordinary names pass: apostrophe, hyphen, umlaut, dot, comma, non-latin', () => {
    for (const n of ["Sinead O'Neil", 'Jörg Müller-Lüdenscheidt', 'Dr. Anna Berger', 'Berger, Anna', '李 小龍', 'Zoë Åkesson']) {
      expect(reasonOf(n), n).toBeUndefined()
    }
  })

  it('a first or last name over 255 characters is rejected (Keycloak length validator)', () => {
    expect(reasonOf(`${'A'.repeat(256)} Berger`)).toBe('malformed_email')
    expect(reasonOf(`Anna ${'B'.repeat(256)}`)).toBe('malformed_email')
    expect(reasonOf(`Anna ${'B'.repeat(255)}`)).toBeUndefined()
  })

  it('an e-mail local part over 64 characters is malformed_email; 64 passes', () => {
    expect(reasonOf('Anna Berger', `${'a'.repeat(65)}@x.example`)).toBe('malformed_email')
    expect(reasonOf('Anna Berger', `${'a'.repeat(64)}@x.example`)).toBeUndefined()
    expect(isPlausibleEmail(`${'a'.repeat(65)}@x.example`)).toBe(false)
  })

  it('an e-mail over 254 characters in total is malformed_email; 254 passes', () => {
    const domain = (n: number) => {
      // labels of 60 characters, a final label to hit the exact length
      const parts: string[] = []
      let left = n
      while (left > 61) {
        parts.push('d'.repeat(60))
        left -= 61
      }
      parts.push('x'.repeat(left - 4), 'com')
      return parts.join('.')
    }
    const at = (total: number) => `${'a'.repeat(60)}@${domain(total - 61)}`
    expect(at(254)).toHaveLength(254)
    expect(at(255)).toHaveLength(255)
    expect(reasonOf('Anna Berger', at(254))).toBeUndefined()
    expect(reasonOf('Anna Berger', at(255))).toBe('malformed_email')
  })

  it('a list that validates applies without a Keycloak-refusable row (the reject comes first, nothing is created)', async () => {
    const report = validateList(HEADER + 'Bad (Name),a@x.example,Assembly,\n', ctx())
    expect(report.status).toBe('rejected')
    const t = new FakeTarget()
    await expect(applyImport(report, ctx().roles, t, report.sha256)).rejects.toThrow(/does not validate/)
    expect(t.calls).toEqual([])
  })
})

describe('redactAddresses', () => {
  it('removes plain and url-encoded addresses and the email= query value', () => {
    const out = redactAddresses('GET /users?email=anna%40x.example&exact=true: user anna@x.example exists; "b.c@d.example"')
    expect(out).not.toMatch(/@|%40|anna|x\.example|d\.example/i)
    expect(out).toMatch(/exists/)
  })
})

describe('apply failures name a row and a reason code, never the address (finding 3)', () => {
  const LEAK = 'Keycloak Admin API error: 409 on POST /admin/realms/r/users?email=anna%40x.example: {"errorMessage":"User anna@x.example exists"}'

  class Failing extends FakeTarget {
    constructor(private readonly at: 'findUserId' | 'ensureAccount' | 'addMembership') {
      super()
    }
    override async findUserId(email: string) {
      if (this.at === 'findUserId') throw new Error(LEAK)
      return super.findUserId(email)
    }
    override async ensureAccount(a: { email: string; firstName: string; lastName: string; role: string }) {
      if (this.at === 'ensureAccount') throw new Error(LEAK)
      return super.ensureAccount(a)
    }
    override async addMembership(m: Parameters<FakeTarget['addMembership']>[0]) {
      if (this.at === 'addMembership') throw new Error(LEAK)
      return super.addMembership(m)
    }
  }

  it.each([
    ['findUserId', 'account_lookup_failed'],
    ['ensureAccount', 'account_failed'],
    ['addMembership', 'membership_failed'],
  ] as const)('a %s failure -> row + %s, no "@"', async (at, code) => {
    const report = validateList(HEADER + 'Anna Berger,anna@x.example,Assembly,\n', ctx())
    const err = await applyImport(report, ctx().roles, new Failing(at), report.sha256).catch((e) => e)
    expect(err).toBeInstanceOf(ImportApplyError)
    expect(err.row).toBe(2)
    expect(err.code).toBe(code)
    expect(err.message).toBe(`row 2: ${code} (http 409)`)
    expect(err.message).not.toMatch(/@|%40|anna|x\.example/i)
    expect(String(err.stack)).not.toMatch(/anna@|%40/i)
    expect((err as { cause?: unknown }).cause).toBeUndefined()
  })
})

describe('apply heartbeat keeps the executor lease alive (finding 6)', () => {
  const many = (n: number) => HEADER + Array.from({ length: n }, (_, i) => `Person ${i},p${i}@x.example,Assembly,`).join('\n') + '\n'

  it('onProgress fires at least every 200 rows in the preflight and in the write loop', async () => {
    const report = validateList(many(450), ctx())
    expect(report.status).toBe('validated')
    const t = new FakeTarget()
    let beats = 0
    await applyImport(report, ctx().roles, t, report.sha256, { onProgress: () => void beats++ })
    // 450 rows: floor(450/200) = 2 beats in the preflight + 2 in the loop
    expect(beats).toBeGreaterThanOrEqual(4)
  })

  it('no onProgress, no beats, no error (the option is optional)', async () => {
    const report = validateList(many(3), ctx())
    await expect(applyImport(report, ctx().roles, new FakeTarget(), report.sha256)).resolves.toMatchObject({ status: 'applied' })
  })
})
