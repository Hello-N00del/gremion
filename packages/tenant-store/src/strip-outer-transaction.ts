// packages/tenant-store/src/strip-outer-transaction.ts
//
// The runner applies each file inside ITS OWN transaction, together with the
// file's schema_migrations row (G-078). A file that carries its own
// `BEGIN; ... COMMIT;` wrapper (finance; calendar's 001_init.sql; kernel 041,
// 043) would commit the runner's transaction early at its COMMIT; — the file
// and its ledger row would no longer be atomic. So the wrapper is removed, as
// an explicit rule (B22), and anything else that controls the transaction is
// refused.
//
// B22's defect, avoided here: its regex carried the m flag, so ^BEGIN also
// matched a line inside a DO $$ ... $$ body and cut the plpgsql BEGIN out of
// it. This file never matches text by line. It scans the file into top-level
// statements — skipping comments, quoted strings, quoted identifiers, dollar
// quotes and SQL-standard BEGIN ATOMIC ... END bodies — and compares whole
// statements: only the FIRST and the LAST statement of the whole file can be
// the wrapper.

export interface Statement {
  /** The statement with comments blanked and the trailing ; removed, trimmed. */
  code: string
  /** Offset of the statement's first code character in the file. */
  start: number
  /** Offset just past its terminating ; (or the end of the file). */
  end: number
}

export class MigrationSqlError extends Error {
  override name = 'MigrationSqlError'
}

const isIdentStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c)
const isIdentChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c)

/** Splits SQL text into top-level statements. Throws on an unterminated token. */
export function splitStatements(text: string): Statement[] {
  const out: Statement[] = []
  let code = ''
  let start = -1
  let i = 0
  // BEGIN ATOMIC ... END nesting, and CASE ... END inside it.
  let atomicDepth = 0
  let caseDepth = 0
  let prevWord = ''

  const pushCode = (s: string, at: number) => {
    if (start < 0 && s.trim() !== '') start = at
    code += s
  }
  const finish = (endAt: number) => {
    const trimmed = code.trim()
    if (trimmed !== '') out.push({ code: trimmed, start, end: endAt })
    code = ''
    start = -1
    prevWord = ''
  }

  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i)
      i = nl < 0 ? text.length : nl
      code += ' '
      continue
    }
    if (c === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < text.length && depth > 0) {
        if (text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      if (depth > 0) throw new MigrationSqlError(`unterminated block comment at offset ${i}`)
      i = j
      code += ' '
      continue
    }
    if (c === "'") {
      // E'...' allows backslash escapes; '' is an escaped quote in both forms.
      const escapes = /[eE]$/.test(code) && !isIdentChar(code.at(-2) ?? ' ')
      let j = i + 1
      for (;;) {
        if (j >= text.length) throw new MigrationSqlError(`unterminated string at offset ${i}`)
        if (escapes && text[j] === '\\') j += 2
        else if (text[j] === "'" && text[j + 1] === "'") j += 2
        else if (text[j] === "'") break
        else j++
      }
      pushCode(text.slice(i, j + 1), i)
      i = j + 1
      prevWord = ''
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (;;) {
        if (j >= text.length) throw new MigrationSqlError(`unterminated quoted identifier at offset ${i}`)
        if (text[j] === '"' && text[j + 1] === '"') j += 2
        else if (text[j] === '"') break
        else j++
      }
      pushCode(text.slice(i, j + 1), i)
      i = j + 1
      prevWord = ''
      continue
    }
    if (c === '$' && !isIdentChar(code.at(-1) ?? ' ')) {
      // $tag$ ... $tag$; the tag cannot start with a digit ($1 is a parameter).
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(text.slice(i))
      if (m) {
        const tag = m[0]
        const close = text.indexOf(tag, i + tag.length)
        if (close < 0) throw new MigrationSqlError(`unterminated dollar quote ${tag} at offset ${i}`)
        pushCode(text.slice(i, close + tag.length), i)
        i = close + tag.length
        prevWord = ''
        continue
      }
    }
    if (isIdentStart(c) && !isIdentChar(code.at(-1) ?? ' ')) {
      let j = i + 1
      while (j < text.length && isIdentChar(text[j]!)) j++
      const word = text.slice(i, j).toUpperCase()
      if (word === 'ATOMIC' && prevWord === 'BEGIN') atomicDepth++
      else if (atomicDepth > 0 && word === 'CASE') caseDepth++
      else if (atomicDepth > 0 && word === 'END') {
        if (caseDepth > 0) caseDepth--
        else atomicDepth--
      }
      prevWord = word
      pushCode(text.slice(i, j), i)
      i = j
      continue
    }
    if (c === ';' && atomicDepth === 0) {
      finish(i + 1)
      i++
      continue
    }
    if (!/\s/.test(c)) prevWord = ''
    pushCode(c, i)
    i++
  }
  if (atomicDepth > 0) throw new MigrationSqlError('unterminated BEGIN ATOMIC body')
  finish(text.length)
  return out
}

const OPEN = /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION)$/i
const CLOSE = /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i
const TX_CONTROL =
  /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION|SET\s+TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS)\b/i

/**
 * Removes a whole-file `BEGIN; ... COMMIT;` wrapper (first and last statement
 * only) and returns the text otherwise byte-for-byte. Throws a
 * MigrationSqlError on an unbalanced wrapper or on any other top-level
 * transaction-control statement, which would break the runner's
 * one-transaction-per-file rule.
 */
export function stripOuterTransaction(text: string): string {
  const stmts = splitStatements(text)
  let body = stmts
  let result = text
  const first = stmts[0]
  const last = stmts.at(-1)
  const opens = first !== undefined && OPEN.test(first.code)
  const closes = stmts.length > 1 && last !== undefined && CLOSE.test(last.code)
  if (opens !== closes) {
    throw new MigrationSqlError(
      `unbalanced transaction wrapper: the file ${opens ? 'opens with' : 'ends with'} ${opens ? first!.code : last!.code} but does not ${opens ? 'end with COMMIT;' : 'open with BEGIN;'}`,
    )
  }
  if (opens && closes) {
    body = stmts.slice(1, -1)
    result = text.slice(0, first!.start) + text.slice(first!.end, last!.start) + text.slice(last!.end)
  }
  const stray = body.find((s) => TX_CONTROL.test(s.code))
  if (stray) {
    throw new MigrationSqlError(`transaction control statement inside a migration body: ${stray.code.split(/\s+/).slice(0, 3).join(' ')}`)
  }
  return result
}
