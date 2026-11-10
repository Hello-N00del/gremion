// What German Excel writes as "CSV UTF-8": a BOM, a semicolon (or tab) as the delimiter, and empty cells padded
// to the right and below. The list is read as the operator meant it; anything else stays refused as a whole.
import { describe, expect, it } from 'vitest'
import { ListFormatError, parseList } from '../src/index.ts'

const A = { name: 'Anna Berger', email: 'a@x.example', body: 'Assembly', role: 'member' }
const B = { name: 'Ben Hoffmann', email: 'b@x.example', body: 'Assembly', role: 'helper' }

describe('delimiters', () => {
  it('a semicolon list with a BOM and CRLF is read', () => {
    const rows = parseList('﻿name;email;body;role\r\nAnna Berger;a@x.example;Assembly;member\r\nBen Hoffmann;b@x.example;Assembly;helper\r\n')
    expect(rows).toEqual([
      { row: 2, ...A },
      { row: 3, ...B },
    ])
  })
  it('a tab-separated list is read', () => {
    const rows = parseList('name\temail\tbody\trole\nAnna Berger\ta@x.example\tAssembly\tmember\n')
    expect(rows).toEqual([{ row: 2, ...A }])
  })
  it('in a semicolon list a comma is text and a quoted semicolon stays inside its field', () => {
    const rows = parseList('name;email;body;role\n"Berger; Anna";a@x.example;Assembly;member\nBerger, Ben;b@x.example;Assembly;helper\n')
    expect(rows.map((r) => r.name)).toEqual(['Berger; Anna', 'Berger, Ben'])
  })
  it('a comma list is read as before', () => {
    expect(parseList('name,email,body,role\n"Berger, Anna",a@x.example,Assembly,member\n')).toEqual([{ row: 2, ...A, name: 'Berger, Anna' }])
  })
})

describe('padding Excel adds', () => {
  it('empty trailing columns are dropped (header and every row)', () => {
    expect(parseList('name;email;body;role;;;\nAnna Berger;a@x.example;Assembly;member;;;\n')).toEqual([{ row: 2, ...A }])
    expect(parseList('name,email,body,role,,\nAnna Berger,a@x.example,Assembly,member,,\n')).toEqual([{ row: 2, ...A }])
  })
  it('an unused role column does not break a list that names it', () => {
    expect(parseList('name;email;body;role;;\nAnna Berger;a@x.example;Assembly;;;\n')).toEqual([{ row: 2, ...A, role: '' }])
  })
  it('all-empty rows are dropped and the rows after them keep their spreadsheet number', () => {
    const rows = parseList('name;email;body;role\nAnna Berger;a@x.example;Assembly;member\n;;;\nBen Hoffmann;b@x.example;Assembly;helper\n;;;\n;;;\n')
    expect(rows).toEqual([
      { row: 2, ...A },
      { row: 4, ...B },
    ])
  })
  it('a trailing column that holds data in any row is not padding: the list is refused', () => {
    expect(() => parseList('name;email;body;;\nAnna Berger;a@x.example;Assembly;;x\n')).toThrow(ListFormatError)
    expect(() => parseList('name,email,body,role,extra\nAnna Berger,a@x.example,Assembly,member,x\n')).toThrow(/1 unknown/)
  })
  it('a ragged row is still refused with its row number', () => {
    expect(() => parseList('name;email;body;role\nAnna Berger;a@x.example;Assembly\n')).toThrow(/row 2 has 3 fields/)
  })
})

describe('what stays refused, and never echoes a cell', () => {
  it('a headerless semicolon list: counts only, no names or addresses in the message', () => {
    let msg = ''
    try {
      parseList('Anna Berger;a@x.example\nBen Hoffmann;b@x.example\n')
    } catch (e) {
      msg = (e as Error).message
      expect((e as ListFormatError).code).toBe('bad_header')
    }
    expect(msg).toMatch(/2 columns read/)
    expect(msg).not.toMatch(/anna|berger|@x\.example/i)
  })
  it('a list that is only padding is empty-headed and refused', () => {
    expect(() => parseList(';;;\n;;;\n')).toThrow(ListFormatError)
  })
})
