import { describe, expect, it } from 'vitest'
import { applyImport, ImportRefused, isNoopRerun, listSha256, parseList, ListFormatError, validateList, validationResult } from '../src/index.ts'
import { BODIES, FakeTarget, fixtureVertical } from './helpers.ts'

const HEADER = 'name,email,body,role\n'
const ctx = () => ({ bodies: BODIES, roles: fixtureVertical().roles })

describe('csv', () => {
  it('reads RFC 4180: quotes, doubled quotes, CRLF, BOM, embedded comma', () => {
    const rows = parseList('﻿name,email,body,role\r\n"Berger, Anna",a@x.example,Assembly,member\r\n"O""Neil",o@x.example,Assembly,\r\n')
    expect(rows.map((r) => [r.row, r.name, r.role])).toEqual([[2, 'Berger, Anna', 'member'], [3, 'O"Neil', '']])
  })
  it('refuses the whole list: bad header, unknown column, too many rows, ragged row, unterminated quote, empty', () => {
    expect(() => parseList('name,mail,body\nA,a@x.example,B')).toThrow(ListFormatError)
    expect(() => parseList('name,email,body,role,extra\n')).toThrow(/header/)
    expect(() => parseList('name,email,body\nA,a@x.example')).toThrow(/fields/)
    expect(() => parseList('name,email,body\n"A,a@x.example,B')).toThrow(/quoted/)
    expect(() => parseList('')).toThrow(/empty/)
    const big = HEADER + Array.from({ length: 2001 }, (_, i) => `N${i},n${i}@x.example,Assembly,`).join('\n')
    expect(() => parseList(big)).toThrow(/cap/)
  })
})

describe('validate', () => {
  it('names every rejected row with a reason code and never echoes an e-mail', () => {
    const text =
      HEADER +
      ',noname@x.example,Assembly,\n' + // 2 missing_name
      'No Mail,,Assembly,\n' + // 3
      'Bad Mail,not-an-address,Assembly,\n' + // 4
      'No Body,a@x.example,,\n' + // 5
      'Odd Body,b@x.example,Nowhere,\n' + // 6
      'Odd Role,c@x.example,Assembly,king\n' + // 7
      'Not Importable,d@x.example,Assembly,officer\n' + // 8
      'Twice,e@x.example,Assembly,\n' + // 9 duplicate: the FIRST row of the set is rejected too
      'Twice Again,E@X.example ,assembly,\n' // 10 duplicate (normalised)
    const r = validateList(text, ctx())
    expect(r.status).toBe('rejected')
    expect(r.rejected.map((x) => [x.row, x.reason])).toEqual([
      [2, 'missing_name'],
      [3, 'missing_email'],
      [4, 'malformed_email'],
      [5, 'unknown_body'],
      [6, 'unknown_body'],
      [7, 'unknown_role'],
      [8, 'unknown_role'],
      [9, 'duplicate_email_in_body'],
      [10, 'duplicate_email_in_body'],
    ])
    expect(JSON.stringify(validationResult(r))).not.toMatch(/@/)
  })
  it('a repeated e-mail rejects EVERY row of the set (duplicate_email_in_body x2) and the list creates no account', async () => {
    const r = validateList(HEADER + 'First,dup@x.example,Assembly,\nSecond,DUP@x.example,Assembly,helper\nThird,ok@x.example,Assembly,\n', ctx())
    expect(r.rejected).toEqual([
      { row: 2, name: 'First', reason: 'duplicate_email_in_body' },
      { row: 3, name: 'Second', reason: 'duplicate_email_in_body' },
    ])
    expect(r.valid.map((v) => v.row)).toEqual([4])
    const t = new FakeTarget()
    await expect(applyImport(r, ctx().roles, t, r.sha256)).rejects.toThrow(ImportRefused)
    expect(t.calls).toEqual([])
  })
  it('the same e-mail in two different bodies is fine; an ambiguous body name is refused', () => {
    const two = validateList(HEADER + 'A,a@x.example,Assembly,\nA,a@x.example,Executive,helper\n', ctx())
    expect(two.status).toBe('validated')
    const dup = { bodies: [...BODIES, { id: 'b-dup', name: 'assembly' }], roles: ctx().roles }
    expect(validateList(HEADER + 'A,a@x.example,Assembly,\n', dup).rejected[0]?.reason).toBe('unknown_body')
  })
  it('the sha256 ignores order, case, whitespace and CRLF but not content', () => {
    const a = validateList(HEADER + 'A One,a@x.example,Assembly,\nB Two,b@x.example,Executive,helper\n', ctx())
    const b = validateList('name,email,body,role\r\nB  Two, B@X.EXAMPLE ,executive,helper\r\nA One,a@x.example,Assembly,member\r\n', ctx())
    const c = validateList(HEADER + 'A One,a@x.example,Assembly,\nB Two,b@x.example,Executive,member\n', ctx())
    expect(a.sha256).toBe(b.sha256)
    expect(a.sha256).not.toBe(c.sha256)
    expect(listSha256([])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('apply', () => {
  const LIST = HEADER + 'Anna Berger,anna@x.example,Assembly,\nBen Hoffmann,ben@x.example,Assembly,helper\nAnna Berger,anna@x.example,Executive,\n'

  it('a reject-all list creates no account (guard: apply refuses an invalid list)', async () => {
    const report = validateList(HEADER + 'A,a@x.example,Nowhere,\n', ctx())
    const t = new FakeTarget()
    await expect(applyImport(report, ctx().roles, t, report.sha256)).rejects.toThrow(ImportRefused)
    expect(t.calls).toEqual([])
  })
  it('apply refuses a list whose sha256 is not the validated one', async () => {
    const report = validateList(LIST, ctx())
    const t = new FakeTarget()
    await expect(applyImport(report, ctx().roles, t, 'f'.repeat(64))).rejects.toThrow(/sha256/)
    expect(t.calls).toEqual([])
  })
  it('creates one account per distinct e-mail and one membership per row, mailing each CREATED user once', async () => {
    const report = validateList(LIST, ctx())
    const t = new FakeTarget()
    const r = await applyImport(report, ctx().roles, t, report.sha256)
    expect(r.status).toBe('applied')
    expect(r.counts).toMatchObject({ created: 3, accounts_created: 2, invites_sent: 2, unchanged: 0, linked_existing: 0, rejected: 0 })
    expect(t.calls.filter((c) => c.startsWith('account:'))).toHaveLength(2)
    expect(t.mails).toBe(2)
    expect(t.rearmed[0]?.sort()).toEqual(['b-assembly', 'b-exec'])
    // the helper is unelected and non-voting; the member elected and voting
    expect([...t.members.values()].filter((m) => !m.voting)).toEqual([{ membershipType: 'unelected', voting: false }])
  })
  it('a rerun creates 0 and mails 0 (TRD-085)', async () => {
    const report = validateList(LIST, ctx())
    const t = new FakeTarget()
    await applyImport(report, ctx().roles, t, report.sha256)
    const mails = t.mails
    const again = await applyImport(report, ctx().roles, t, report.sha256)
    expect(isNoopRerun(again)).toBe(true)
    expect(again.counts).toMatchObject({ created: 0, unchanged: 3, accounts_created: 0, invites_sent: 0 })
    expect(t.mails).toBe(mails)
  })
  it('links an existing account without a second mail', async () => {
    const t = new FakeTarget()
    t.preexisting('anna@x.example')
    const report = validateList(HEADER + 'Anna Berger,anna@x.example,Assembly,\n', ctx())
    const r = await applyImport(report, ctx().roles, t, report.sha256)
    expect(r.counts).toMatchObject({ created: 1, linked_existing: 1, accounts_created: 0, invites_sent: 0 })
    expect(t.mails).toBe(0)
  })
  it('a found membership of another role is role_changed: refused BEFORE any account is created', async () => {
    const t = new FakeTarget()
    t.preexisting('anna@x.example', 'u-anna')
    t.members.set('b-assembly|u-anna', { membershipType: 'unelected', voting: false })
    const report = validateList(HEADER + 'Anna Berger,anna@x.example,Assembly,member\nNew Person,new@x.example,Assembly,\n', ctx())
    const r = await applyImport(report, ctx().roles, t, report.sha256)
    expect(r.status).toBe('rejected')
    expect(r.rows).toEqual([{ row: 2, name: 'Anna Berger', reason: 'role_changed' }])
    expect(t.calls).toEqual([])
  })
})
