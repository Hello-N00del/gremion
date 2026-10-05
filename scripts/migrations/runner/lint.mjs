// scripts/migrations/runner/lint.mjs -- TASK-075 (TRD-361, TRD-444).
//
// The expand/contract lint: a migration that would break the colour still
// serving traffic is refused before merge. Every file declares its phase on
// its first line (`-- gremion:phase expand|migrate|contract`, see
// packages/tenant-store/src/phase.ts) and is checked against that phase:
//
//   expand    a FAIL-CLOSED allow-list (SCHEMA §0.10): only statements the
//             old colour cannot notice. Everything not on the list, and every
//             statement the parser cannot read, is refused by name.
//   migrate   the expand list plus UPDATE/INSERT, but only after the statement
//             that sets the tenant context (set_config(.., true) / SET LOCAL
//             of the tenant-store GUC). "Batched" is a database-lens review
//             item (README), never claimed here.
//   contract  anything, but only with `-- gremion:contract-after dist-vX.Y.Z`
//             naming the NEWEST dist-v* tag reachable from HEAD, a tag whose
//             tree does not contain the file and in which no dropped or
//             tightened identifier is still referenced outside the migration
//             directories and fixtures (checkContract, needs git).
//
// Every phase must set lock_timeout (SET [LOCAL] lock_timeout, SCHEMA:4784)
// before its first statement that takes a lock.
//
// Dependency-free (Q6): the statement splitter is tenant-store's own
// (strip-outer-transaction.ts, import-free, loads under Node's type
// stripping); the tokenizer below reads its comment-blanked statements.
import { spawnSync } from 'node:child_process'
import { splitStatements } from '../../../packages/tenant-store/src/strip-outer-transaction.ts'
import { DIST_TAG, parseHeader } from '../../../packages/tenant-store/src/phase.ts'

/** The tenant-store tenant-context GUC(s) a migrate file must set before DML. */
export const TENANT_CONTEXT_GUCS = ['gremion.customer_id']

// ── tokenizer ────────────────────────────────────────────────────────────────

const IDENT_START = /[A-Za-z_\u0080-￿]/
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/

/**
 * Tokens of one comment-free statement: word (up = upper-case), qident
 * ("quoted", v = the unquoted name), string ('...', E'...', v = raw), dollar
 * ($tag$...$tag$), number, op (punctuation, multi-char :: <= >= <> != ||).
 */
export function tokenize(code) {
  const out = []
  let i = 0
  while (i < code.length) {
    const c = code[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if ((c === 'E' || c === 'e') && code[i + 1] === "'") {
      const j = scanString(code, i + 1, true)
      out.push({ t: 'string', v: code.slice(i, j) })
      i = j
      continue
    }
    if (c === "'") {
      const j = scanString(code, i, false)
      out.push({ t: 'string', v: code.slice(i, j) })
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      let name = ''
      for (;;) {
        if (j >= code.length) throw new SyntaxError('unterminated quoted identifier')
        if (code[j] === '"' && code[j + 1] === '"') {
          name += '"'
          j += 2
        } else if (code[j] === '"') break
        else name += code[j++]
      }
      out.push({ t: 'qident', v: name, up: name })
      i = j + 1
      continue
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(code.slice(i))
      if (m) {
        const close = code.indexOf(m[0], i + m[0].length)
        if (close < 0) throw new SyntaxError('unterminated dollar quote')
        out.push({ t: 'dollar', v: code.slice(i, close + m[0].length) })
        i = close + m[0].length
        continue
      }
      const p = /^\$\d+/.exec(code.slice(i))
      if (p) {
        out.push({ t: 'param', v: p[0] })
        i += p[0].length
        continue
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(code.slice(i))
      out.push({ t: 'number', v: m[0] })
      i += m[0].length
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (j < code.length && IDENT_CHAR.test(code[j])) j++
      const v = code.slice(i, j)
      out.push({ t: 'word', v, up: v.toUpperCase() })
      i = j
      continue
    }
    const two = code.slice(i, i + 2)
    if (['::', '<=', '>=', '<>', '!=', '||', '=>', ':='].includes(two)) {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    out.push({ t: 'op', v: c })
    i++
  }
  return out
}

function scanString(code, i, escapes) {
  let j = i + 1
  for (;;) {
    if (j >= code.length) throw new SyntaxError('unterminated string')
    if (escapes && code[j] === '\\') j += 2
    else if (code[j] === "'" && code[j + 1] === "'") j += 2
    else if (code[j] === "'") return j + 1
    else j++
  }
}

// ── small parsing helpers over a token array ─────────────────────────────────

const isWord = (tok, ...words) => tok?.t === 'word' && (words.length === 0 || words.includes(tok.up))
const isOp = (tok, v) => tok?.t === 'op' && tok.v === v

/** Expects the word sequence at i; returns the index after it, or -1. */
function words(toks, i, ...seq) {
  for (const w of seq) {
    if (!isWord(toks[i], w)) return -1
    i++
  }
  return i
}

/** Skips an optional word sequence. */
function opt(toks, i, ...seq) {
  const j = words(toks, i, ...seq)
  return j < 0 ? i : j
}

const identName = (tok) => (tok?.t === 'qident' ? tok.v : tok?.t === 'word' ? tok.v.toLowerCase() : null)

/** A possibly schema-qualified name at i: {parts, next} or null. */
function qname(toks, i) {
  const first = identName(toks[i])
  if (first === null) return null
  const parts = [first]
  let j = i + 1
  while (isOp(toks[j], '.') && identName(toks[j + 1]) !== null) {
    parts.push(identName(toks[j + 1]))
    j += 2
  }
  return { parts, next: j }
}

const nameKey = (parts) => parts.join('.')

/** Splits tokens at top-level commas (parentheses and brackets balanced). */
function splitTopLevel(toks, sep = ',') {
  const out = [[]]
  let depth = 0
  for (const tok of toks) {
    if (isOp(tok, '(') || isOp(tok, '[')) depth++
    if (isOp(tok, ')') || isOp(tok, ']')) depth--
    if (depth === 0 && isOp(tok, sep)) out.push([])
    else out.at(-1).push(tok)
  }
  return out.filter((p) => p.length > 0)
}

/** Index of the matching ')' for the '(' at i. */
function closeParen(toks, i) {
  let depth = 0
  for (let j = i; j < toks.length; j++) {
    if (isOp(toks[j], '(')) depth++
    else if (isOp(toks[j], ')') && --depth === 0) return j
  }
  return -1
}

// ── the same-file table set ──────────────────────────────────────────────────

class Created {
  constructor() {
    this.tables = []
  }
  add(parts) {
    this.tables.push(parts)
  }
  /** Same table if the full names agree, or one side is unqualified and the last parts agree. */
  has(parts) {
    return this.tables.some((t) => nameKey(t) === nameKey(parts) || ((t.length === 1 || parts.length === 1) && t.at(-1) === parts.at(-1)))
  }
}

// ── statement rules ──────────────────────────────────────────────────────────

/** Rule names, as printed in every failure (file, statement number, rule). */
export const RULES = {
  unparseable: 'unparseable',
  headerMissing: 'phase-header-missing',
  headerMalformed: 'phase-header-malformed',
  noLockTimeout: 'no-lock-timeout',
  txControl: 'transaction-control',
  notAllowed: 'not-in-allow-list',
  drop: 'drop',
  rename: 'rename',
  alterColumnType: 'alter-column-type',
  setNotNull: 'set-not-null',
  alterColumn: 'alter-column',
  notNullNoDefault: 'not-null-without-default',
  volatileDefault: 'volatile-default',
  uuidv7Default: 'uuidv7-default',
  columnConstraint: 'column-constraint-on-existing-table',
  truncate: 'truncate',
  delete: 'delete',
  update: 'update',
  insertExisting: 'insert-into-existing-table',
  dmlBeforeTenant: 'dml-before-tenant-context',
  revoke: 'revoke',
  createExtension: 'create-extension',
  orReplace: 'or-replace',
  notNewName: 'function-or-view-not-new',
  doBlock: 'do-block',
  concurrently: 'index-concurrently',
  indexExisting: 'index-on-existing-table',
  triggerExisting: 'trigger-on-existing-table',
  rlsExisting: 'rls-on-existing-table',
  policyExisting: 'policy-on-existing-table',
  foreignKey: 'foreign-key',
  checkNotValid: 'check-without-not-valid',
  constraintExisting: 'constraint-on-existing-table',
  createTableAs: 'create-table-as',
  inheritsExisting: 'inherits-existing-table',
  contractAfterMissing: 'contract-after-missing',
  noDistTag: 'no-dist-tag',
  contractAfterUnknown: 'contract-after-unknown-tag',
  contractAfterNotAncestor: 'contract-after-not-ancestor',
  contractAfterNotNewest: 'contract-after-not-newest',
  contractAfterContainsFile: 'contract-after-contains-file',
  identifierReferenced: 'identifier-still-referenced',
  manualDumpMissing: 'manual-dump-marker-missing',
}

const LITERAL_FUNCS = new Set(['NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'LOCALTIMESTAMP', 'TRANSACTION_TIMESTAMP'])

/**
 * A default the server evaluates ONCE at ALTER time (no table rewrite, the
 * PG11+ fast default): a literal, optionally cast, or a STABLE clock function.
 * Returns null when allowed, else the rule.
 */
function checkDefault(toks) {
  let t = toks
  // strip a trailing cast chain: <expr> ::type[(n)][[]]
  const cast = t.findIndex((x) => isOp(x, '::'))
  if (cast >= 0) {
    const tail = t.slice(cast + 1)
    if (!tail.every((x) => x.t === 'word' || x.t === 'qident' || x.t === 'number' || isOp(x, '(') || isOp(x, ')') || isOp(x, '[') || isOp(x, ']') || isOp(x, ',') || isOp(x, '.') || isOp(x, '::'))) return RULES.volatileDefault
    t = t.slice(0, cast)
  }
  if (t.length === 1 && (t[0].t === 'string' || t[0].t === 'number')) return null
  if (t.length === 2 && isOp(t[0], '-') && t[1].t === 'number') return null
  if (t.length === 1 && isWord(t[0], 'TRUE', 'FALSE', 'NULL', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'LOCALTIMESTAMP')) return null
  if (t.length === 3 && isWord(t[0]) && LITERAL_FUNCS.has(t[0].up) && isOp(t[1], '(') && isOp(t[2], ')')) return null
  if (t.some((x) => isWord(x, 'UUIDV7'))) return RULES.uuidv7Default
  return RULES.volatileDefault
}

/** ALTER TABLE <existing> ADD [COLUMN] [IF NOT EXISTS] name type [constraints]. */
function checkAddColumn(toks) {
  // toks: after ADD [COLUMN] [IF NOT EXISTS]
  let i = 1 // skip the column name
  // the type: everything up to the first constraint keyword at depth 0
  const CONSTRAINT_WORDS = ['NOT', 'NULL', 'DEFAULT', 'COLLATE', 'CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'REFERENCES', 'GENERATED', 'COMPRESSION', 'STORAGE']
  let depth = 0
  for (; i < toks.length; i++) {
    if (isOp(toks[i], '(')) depth++
    if (isOp(toks[i], ')')) depth--
    if (depth === 0 && isWord(toks[i], ...CONSTRAINT_WORDS)) break
  }
  let notNull = false
  let hasDefault = false
  while (i < toks.length) {
    const tok = toks[i]
    if (isWord(tok, 'NOT') && isWord(toks[i + 1], 'NULL')) {
      notNull = true
      i += 2
    } else if (isWord(tok, 'NULL')) {
      i++
    } else if (isWord(tok, 'COLLATE')) {
      const q = qname(toks, i + 1)
      if (!q) return RULES.unparseable
      i = q.next
    } else if (isWord(tok, 'DEFAULT')) {
      let j = i + 1
      let d = 0
      for (; j < toks.length; j++) {
        if (isOp(toks[j], '(')) d++
        if (isOp(toks[j], ')')) d--
        if (d === 0 && j > i + 1 && isWord(toks[j], 'NOT', 'NULL', 'COLLATE', 'CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'REFERENCES', 'GENERATED') && !isOp(toks[j - 1], '::')) break
      }
      const rule = checkDefault(toks.slice(i + 1, j))
      if (rule) return rule
      hasDefault = true
      i = j
    } else if (isWord(tok, 'REFERENCES')) {
      return RULES.foreignKey
    } else {
      // CONSTRAINT, CHECK, UNIQUE, PRIMARY KEY, GENERATED, ...: each validates
      // or rewrites the existing table.
      return RULES.columnConstraint
    }
  }
  if (notNull && !hasDefault) return RULES.notNullNoDefault
  return null
}

/**
 * TASK-044: ADD CONSTRAINT <name> FOREIGN KEY (..) REFERENCES <t> (..) [ON
 * DELETE/UPDATE ..] NOT VALID, where <t> is a table THIS file created. The
 * SCHEMA §0.10 analogue of the CHECK ... NOT VALID expand form: no existing row
 * is read, and the serving colour neither locks nor reads a table that did not
 * exist before this file. Named constraints only (SCHEMA naming rule 19).
 */
function isNewTableForeignKeyNotValid(toks, state) {
  // toks: after ADD
  if (!isWord(toks[0], 'CONSTRAINT') || identName(toks[1]) === null) return false
  if (!isWord(toks[2], 'FOREIGN') || !isWord(toks[3], 'KEY') || !isOp(toks[4], '(')) return false
  const cols = closeParen(toks, 4)
  if (cols < 0 || !isWord(toks[cols + 1], 'REFERENCES')) return false
  const ref = qname(toks, cols + 2)
  if (!ref || !state.created.has(ref.parts)) return false
  const n = toks.length
  return n >= 2 && isWord(toks[n - 2], 'NOT') && isWord(toks[n - 1], 'VALID')
}

/** ALTER TABLE <existing> ADD CONSTRAINT ... / ADD CHECK ... */
function checkAddConstraint(toks, state) {
  // toks: after ADD
  let i = 0
  if (isWord(toks[0], 'CONSTRAINT')) i = 2
  if (isWord(toks[i], 'FOREIGN')) return isNewTableForeignKeyNotValid(toks, state) ? null : RULES.foreignKey
  if (isWord(toks[i], 'CHECK')) {
    const close = closeParen(toks, i + 1)
    if (close < 0) return RULES.unparseable
    const rest = toks.slice(close + 1)
    if (rest.length === 2 && isWord(rest[0], 'NOT') && isWord(rest[1], 'VALID')) return null
    return RULES.checkNotValid
  }
  return RULES.constraintExisting
}

/** One ALTER TABLE action on a table the file did not create. */
function checkAlterAction(toks, state) {
  const w = toks[0]
  if (isWord(w, 'ADD')) {
    let i = 1
    if (isWord(toks[1], 'CONSTRAINT', 'CHECK', 'FOREIGN', 'PRIMARY', 'UNIQUE', 'EXCLUDE')) return checkAddConstraint(toks.slice(1), state)
    i = opt(toks, i, 'COLUMN')
    i = opt(toks, i, 'IF', 'NOT', 'EXISTS')
    return checkAddColumn(toks.slice(i))
  }
  if (isWord(w, 'VALIDATE') && isWord(toks[1], 'CONSTRAINT') && toks.length === 3) return null
  if (isWord(w, 'DROP')) return RULES.drop
  if (isWord(w, 'RENAME')) return RULES.rename
  if (isWord(w, 'ENABLE', 'FORCE') && isWord(toks[1], 'ROW')) return RULES.rlsExisting
  if (isWord(w, 'ALTER')) {
    let i = opt(toks, 1, 'COLUMN')
    i++ // column name
    if (isWord(toks[i], 'TYPE') || (isWord(toks[i], 'SET') && isWord(toks[i + 1], 'DATA'))) return RULES.alterColumnType
    if (isWord(toks[i], 'SET') && isWord(toks[i + 1], 'NOT') && isWord(toks[i + 2], 'NULL')) return RULES.setNotNull
    if (isWord(toks[i], 'DROP')) return RULES.drop
    return RULES.alterColumn
  }
  return RULES.notAllowed
}

/** The lock_timeout setter: SET [LOCAL|SESSION] lock_timeout {TO|=} value. */
function isLockTimeout(toks) {
  let i = words(toks, 0, 'SET')
  if (i < 0) return false
  i = opt(toks, i, 'LOCAL')
  i = opt(toks, i, 'SESSION')
  return isWord(toks[i], 'LOCK_TIMEOUT') && (isWord(toks[i + 1], 'TO') || isOp(toks[i + 1], '='))
}

const unquoteString = (v) => v.replace(/^[eE]?'/, '').replace(/'$/, '').replaceAll("''", "'")

/** SET LOCAL <tenant guc> ..., or SELECT set_config('<tenant guc>', <x>, true)[, ...]. */
function isTenantContext(toks) {
  if (isWord(toks[0], 'SET') && isWord(toks[1], 'LOCAL')) {
    const q = qname(toks, 2)
    return q !== null && TENANT_CONTEXT_GUCS.includes(nameKey(q.parts))
  }
  if (!isWord(toks[0], 'SELECT')) return false
  const calls = splitTopLevel(toks.slice(1))
  if (calls.length === 0) return false
  let tenant = false
  for (const call of calls) {
    let i = 0
    if (isWord(call[0], 'PG_CATALOG') && isOp(call[1], '.')) i = 2
    if (!isWord(call[i], 'SET_CONFIG') || !isOp(call[i + 1], '(')) return false
    const close = closeParen(call, i + 1)
    if (close !== call.length - 1) return false
    const args = splitTopLevel(call.slice(i + 2, close))
    if (args.length !== 3 || args[0].length !== 1 || args[0][0].t !== 'string') return false
    if (!(args[2].length === 1 && isWord(args[2][0], 'TRUE'))) return false
    if (TENANT_CONTEXT_GUCS.includes(unquoteString(args[0][0].v))) tenant = true
  }
  return tenant
}

const OPEN_TX = /^(?:BEGIN(?:\s+(?:WORK|TRANSACTION))?|START\s+TRANSACTION)$/i
const CLOSE_TX = /^(?:COMMIT|END)(?:\s+(?:WORK|TRANSACTION))?$/i

/**
 * Names CREATE FUNCTION/PROCEDURE/VIEW statements create in `text` (lower-case
 * last part). Unreadable text yields what could be read.
 */
export function createdRoutineNames(text) {
  const out = new Set()
  let stmts
  try {
    stmts = splitStatements(text)
  } catch {
    return out
  }
  for (const s of stmts) {
    let toks
    try {
      toks = tokenize(s.code)
    } catch {
      continue
    }
    let i = words(toks, 0, 'CREATE')
    if (i < 0) continue
    i = opt(toks, i, 'OR', 'REPLACE')
    i = opt(toks, i, 'TEMP')
    i = opt(toks, i, 'TEMPORARY')
    i = opt(toks, i, 'RECURSIVE')
    if (!isWord(toks[i], 'FUNCTION', 'PROCEDURE', 'VIEW')) continue
    const q = qname(toks, i + 1)
    // TASK-044: schema.name when qualified (ops.touch_row is not plt.touch_row)
    if (q) out.add(q.parts.length > 1 ? nameKey(q.parts.slice(-2)) : q.parts[0])
  }
  return out
}

/**
 * TASK-044: whether `parts` names a routine an earlier file created. Same rule
 * as the same-file table set (Created.has): the full names agree, or one side
 * is unqualified and the last parts agree (the search_path decides it).
 */
function routineSeen(prior, parts) {
  const name = parts.at(-1)
  const full = parts.length > 1 ? nameKey(parts.slice(-2)) : null
  for (const p of prior) {
    const dot = p.lastIndexOf('.')
    const pName = dot < 0 ? p : p.slice(dot + 1)
    if (pName !== name) continue
    if (dot < 0 || full === null || p === full) return true
  }
  return false
}

/**
 * Classifies one statement under `phase`. Returns null (allowed) or a rule.
 * `state` carries the same-file tables, lock_timeout and tenant context.
 */
function checkStatement(toks, phase, state, priorRoutines) {
  const w0 = toks[0]
  if (!w0) return null
  if (isWord(w0, 'SET')) {
    if (isLockTimeout(toks)) {
      state.lockTimeout = true
      return null
    }
    if (phase === 'migrate' && isTenantContext(toks)) {
      state.tenant = true
      return null
    }
    return phase === 'contract' ? null : RULES.notAllowed
  }
  if (isWord(w0, 'SELECT') && phase === 'migrate' && isTenantContext(toks)) {
    state.tenant = true
    return null
  }
  // Everything below takes a lock: lintSql has already required lock_timeout.
  if (phase === 'contract') {
    state.dropped.push(...droppedIdentifiers(toks))
    return null
  }

  if (isWord(w0, 'COMMENT') || isWord(w0, 'GRANT')) return null
  if (isWord(w0, 'REVOKE')) return RULES.revoke
  if (isWord(w0, 'DROP')) return RULES.drop
  if (isWord(w0, 'TRUNCATE')) return RULES.truncate
  if (isWord(w0, 'DELETE')) return RULES.delete
  if (isWord(w0, 'DO')) return RULES.doBlock
  if (isWord(w0, 'UPDATE')) {
    if (phase !== 'migrate') return RULES.update
    return state.tenant ? null : RULES.dmlBeforeTenant
  }
  if (isWord(w0, 'INSERT')) {
    if (!isWord(toks[1], 'INTO')) return RULES.notAllowed
    const q = qname(toks, 2)
    if (!q) return RULES.unparseable
    if (phase === 'migrate') return state.tenant ? null : RULES.dmlBeforeTenant
    return state.created.has(q.parts) ? null : RULES.insertExisting
  }
  if (isWord(w0, 'ALTER') && isWord(toks[1], 'TABLE')) {
    let i = 2
    i = opt(toks, i, 'IF', 'EXISTS')
    i = opt(toks, i, 'ONLY')
    const q = qname(toks, i)
    if (!q) return RULES.unparseable
    let j = q.next
    if (isOp(toks[j], '*')) j++
    const actions = toks.slice(j)
    if (actions.length === 0) return RULES.unparseable
    if (isWord(actions[0], 'RENAME')) return state.created.has(q.parts) ? null : RULES.rename
    if (state.created.has(q.parts)) return null
    for (const action of splitTopLevel(actions)) {
      const rule = checkAlterAction(action, state)
      if (rule) return rule
    }
    return null
  }
  if (isWord(w0, 'CREATE')) {
    let i = 1
    if (isWord(toks[1], 'OR') && isWord(toks[2], 'REPLACE')) return RULES.orReplace
    if (isWord(toks[i], 'EXTENSION')) return RULES.createExtension
    if (isWord(toks[i], 'SCHEMA')) {
      i = opt(toks, i + 1, 'IF', 'NOT', 'EXISTS')
      const q = qname(toks, i)
      if (!q) {
        // CREATE SCHEMA AUTHORIZATION role
        return isWord(toks[i], 'AUTHORIZATION') && toks.length === i + 2 ? null : RULES.unparseable
      }
      const rest = toks.slice(q.next)
      return rest.length === 0 || (rest.length === 2 && isWord(rest[0], 'AUTHORIZATION')) ? null : RULES.notAllowed
    }
    if (isWord(toks[i], 'UNLOGGED')) i++
    if (isWord(toks[i], 'TABLE')) {
      i = opt(toks, i + 1, 'IF', 'NOT', 'EXISTS')
      const q = qname(toks, i)
      if (!q) return RULES.unparseable
      const rest = toks.slice(q.next)
      if (isWord(rest[0], 'AS')) return RULES.createTableAs
      if (isWord(rest[0], 'PARTITION') && isWord(rest[1], 'OF')) {
        const parent = qname(rest, 2)
        if (!parent || !state.created.has(parent.parts)) return RULES.inheritsExisting
      } else if (!isOp(rest[0], '(')) return RULES.unparseable
      const close = isOp(rest[0], '(') ? closeParen(rest, 0) : -1
      if (close >= 0 && isWord(rest[close + 1], 'INHERITS')) {
        for (const p of splitTopLevel(rest.slice(close + 3, closeParen(rest, close + 2)))) {
          const parent = qname(p, 0)
          if (!parent || !state.created.has(parent.parts)) return RULES.inheritsExisting
        }
      }
      state.created.add(q.parts)
      return null
    }
    if (isWord(toks[i], 'UNIQUE')) i++
    if (isWord(toks[i], 'INDEX')) {
      i++
      if (isWord(toks[i], 'CONCURRENTLY')) return RULES.concurrently
      i = opt(toks, i, 'IF', 'NOT', 'EXISTS')
      if (!isWord(toks[i], 'ON')) i = qname(toks, i)?.next ?? i
      if (!isWord(toks[i], 'ON')) return RULES.unparseable
      i = opt(toks, i + 1, 'ONLY')
      const q = qname(toks, i)
      if (!q) return RULES.unparseable
      return state.created.has(q.parts) ? null : RULES.indexExisting
    }
    if (isWord(toks[i], 'CONSTRAINT') && isWord(toks[i + 1], 'TRIGGER')) i++
    if (isWord(toks[i], 'TRIGGER')) {
      const on = toks.findIndex((x, k) => k > i + 1 && isWord(x, 'ON'))
      if (on < 0) return RULES.unparseable
      const q = qname(toks, on + 1)
      if (!q) return RULES.unparseable
      return state.created.has(q.parts) ? null : RULES.triggerExisting
    }
    if (isWord(toks[i], 'POLICY')) {
      const on = toks.findIndex((x, k) => k > i + 1 && isWord(x, 'ON'))
      if (on < 0) return RULES.unparseable
      const q = qname(toks, on + 1)
      if (!q) return RULES.unparseable
      return state.created.has(q.parts) ? null : RULES.policyExisting
    }
    if (isWord(toks[i], 'FUNCTION', 'VIEW')) {
      const q = qname(toks, i + 1)
      if (!q) return RULES.unparseable
      return routineSeen(priorRoutines, q.parts) ? RULES.notNewName : null
    }
    return RULES.notAllowed
  }
  return RULES.notAllowed
}

/**
 * Identifiers a contract statement drops or tightens (lower-case last part):
 * DROP <kind> names, ALTER TABLE .. DROP [COLUMN] c, RENAME [COLUMN] a TO b
 * (a), RENAME TO (the old table), ALTER [COLUMN] c TYPE | SET DATA TYPE |
 * SET NOT NULL, ALTER <kind> x RENAME TO (x).
 */
export function droppedIdentifiers(toks) {
  const out = []
  if (isWord(toks[0], 'DROP')) {
    let i = 1
    if (isWord(toks[i], 'MATERIALIZED')) i++
    if (isWord(toks[i], 'TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'INDEX', 'TYPE', 'SEQUENCE', 'SCHEMA', 'TRIGGER', 'POLICY', 'DOMAIN', 'AGGREGATE')) {
      i++
      if (isWord(toks[i], 'CONCURRENTLY')) i++
      i = opt(toks, i, 'IF', 'EXISTS')
      const until = toks.findIndex((x, k) => k >= i && isWord(x, 'ON', 'CASCADE', 'RESTRICT'))
      for (const part of splitTopLevel(toks.slice(i, until < 0 ? toks.length : until))) {
        const q = qname(part, 0)
        if (q) out.push(q.parts.at(-1))
      }
    }
    return out
  }
  if (isWord(toks[0], 'ALTER')) {
    let i = 1
    if (isWord(toks[i], 'MATERIALIZED')) i++
    if (!isWord(toks[i], 'TABLE', 'VIEW', 'FUNCTION', 'PROCEDURE', 'INDEX', 'TYPE', 'SEQUENCE', 'SCHEMA')) return out
    const isTable = isWord(toks[i], 'TABLE')
    i = opt(toks, i + 1, 'IF', 'EXISTS')
    i = opt(toks, i, 'ONLY')
    const q = qname(toks, i)
    if (!q) return out
    let j = q.next
    if (isOp(toks[j], '(')) j = closeParen(toks, j) + 1
    const rest = toks.slice(j)
    if (isWord(rest[0], 'RENAME')) {
      if (isWord(rest[1], 'TO')) out.push(q.parts.at(-1))
      else {
        let k = opt(rest, 1, 'COLUMN')
        k = opt(rest, k, 'CONSTRAINT')
        const c = identName(rest[k])
        if (c) out.push(c)
      }
      return out
    }
    if (!isTable) return out
    for (const action of splitTopLevel(rest)) {
      if (isWord(action[0], 'DROP') && !isWord(action[1], 'CONSTRAINT', 'NOT', 'DEFAULT')) {
        let k = opt(action, 1, 'COLUMN')
        k = opt(action, k, 'IF', 'EXISTS')
        const c = identName(action[k])
        if (c) out.push(c)
      } else if (isWord(action[0], 'ALTER')) {
        const k = opt(action, 1, 'COLUMN')
        const c = identName(action[k])
        const verb = action.slice(k + 1)
        if (c && (isWord(verb[0], 'TYPE') || (isWord(verb[0], 'SET') && isWord(verb[1], 'DATA', 'NOT')))) out.push(c)
      }
    }
  }
  return out
}

/**
 * Lints one migration's text. Returns { phase, contractAfter, manualDump,
 * dropped, problems: [{statement, rule, message}] }. statement is 1-based;
 * 0 = the file as a whole (header, lock_timeout). Contract files are checked
 * here for their statements only; checkContract does the git half.
 */
export function lintSql(text, { priorRoutines = new Set(), classifyAs = null } = {}) {
  // classifyAs (baseline.mjs only): judge a pre-header legacy file AS IF it
  // declared that phase -- no header, no lock_timeout, and (migrate) no
  // tenant context required, since the legacy chains predate all three.
  const header = classifyAs ? { phase: classifyAs, contractAfter: null, manualDump: null, problems: [] } : parseHeader(text)
  const res = { phase: header.phase, contractAfter: header.contractAfter, manualDump: header.manualDump, dropped: [], problems: [] }
  const fail = (statement, rule, message) => {
    if (classifyAs && (rule === RULES.noLockTimeout || rule === RULES.dmlBeforeTenant)) return
    res.problems.push({ statement, rule, message })
  }
  if (header.problems.length) fail(0, RULES.headerMalformed, header.problems.join('; '))
  if (header.phase === null) {
    if (!header.problems.length) fail(0, RULES.headerMissing, 'the first line must be -- gremion:phase expand|migrate|contract')
    return res
  }
  let stmts
  try {
    stmts = splitStatements(text)
  } catch (err) {
    fail(0, RULES.unparseable, err.message)
    return res
  }
  const state = { created: new Created(), lockTimeout: false, tenant: false, dropped: [] }
  const last = stmts.length - 1
  let lockTimeoutReported = false
  stmts.forEach((s, idx) => {
    const n = idx + 1
    if (OPEN_TX.test(s.code) || CLOSE_TX.test(s.code)) {
      const wrapper = (idx === 0 && OPEN_TX.test(s.code)) || (idx === last && idx > 0 && CLOSE_TX.test(s.code))
      if (!wrapper) fail(n, RULES.txControl, `${s.code} is not the file's outer BEGIN;/COMMIT; wrapper`)
      return
    }
    let toks
    try {
      toks = tokenize(s.code)
    } catch (err) {
      fail(n, RULES.unparseable, err.message)
      return
    }
    if (/^(?:ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE|COMMIT|END)\b/i.test(s.code)) {
      fail(n, RULES.txControl, s.code.split(/\s+/).slice(0, 2).join(' '))
      return
    }
    const settingOnly = isLockTimeout(toks) || (header.phase === 'migrate' && isTenantContext(toks))
    if (!settingOnly && !state.lockTimeout && !lockTimeoutReported) {
      lockTimeoutReported = true
      fail(n, RULES.noLockTimeout, `statement ${n} takes a lock before any SET [LOCAL] lock_timeout`)
    }
    const rule = checkStatement(toks, header.phase, state, priorRoutines)
    if (rule) fail(n, rule, `${s.code.replace(/\s+/g, ' ').slice(0, 80)}`)
  })
  if (!state.lockTimeout && !lockTimeoutReported) fail(0, RULES.noLockTimeout, 'no SET [LOCAL] lock_timeout in the file')
  res.dropped = [...new Set(state.dropped)]
  return res
}

// ── the contract rule (git) ──────────────────────────────────────────────────

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  return r
}

/** dist-v* tags, highest version first. */
export function sortDistTags(tags) {
  const v = (t) => DIST_TAG.exec(t).slice(1).map(Number)
  return tags
    .filter((t) => DIST_TAG.test(t))
    .sort((a, b) => {
      const x = v(a)
      const y = v(b)
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]
      return 0
    })
}

/**
 * The git half of a contract (TRD-361). `file` is the repo-relative path,
 * `excludeDirs` the migration directories (repo-relative) whose own text is
 * not a "reference". Returns [{rule, message}] (empty = passes).
 */
export function checkContract({ cwd, file, contractAfter, dropped = [], excludeDirs = [] }) {
  const problems = []
  const fail = (rule, message) => problems.push({ rule, message })
  if (!contractAfter) {
    fail(RULES.contractAfterMissing, 'a contract file needs -- gremion:contract-after dist-vX.Y.Z')
    return problems
  }
  const merged = git(cwd, ['tag', '--list', 'dist-v*', '--merged', 'HEAD'])
  if (merged.status !== 0) {
    fail(RULES.unparseable, `git tag --merged HEAD failed: ${merged.stderr.trim()}`)
    return problems
  }
  const reachable = sortDistTags(merged.stdout.split('\n').map((s) => s.trim()).filter(Boolean))
  const all = git(cwd, ['tag', '--list', 'dist-v*']).stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (all.length === 0) {
    fail(RULES.noDistTag, 'no dist-v* release tag exists yet: every contract fails until the first release')
    return problems
  }
  if (!all.includes(contractAfter)) {
    fail(RULES.contractAfterUnknown, `${contractAfter} is not a tag`)
    return problems
  }
  if (!reachable.includes(contractAfter)) {
    fail(RULES.contractAfterNotAncestor, `${contractAfter} is not reachable from HEAD`)
    return problems
  }
  if (reachable[0] !== contractAfter) {
    fail(RULES.contractAfterNotNewest, `${contractAfter} is not the newest dist-v* tag reachable from HEAD (${reachable[0]} is)`)
    return problems
  }
  if (git(cwd, ['cat-file', '-e', `${contractAfter}:${file}`]).status === 0) {
    fail(RULES.contractAfterContainsFile, `${contractAfter} already contains ${file}: the contract must ship after that release, not in it`)
    return problems
  }
  const excludes = [...excludeDirs.map((d) => `:(exclude)${d}`), ':(exclude,glob)**/fixtures/**', ':(exclude,glob)**/__fixtures__/**']
  for (const ident of dropped) {
    const r = git(cwd, ['grep', '-l', '-w', '-F', '-I', '-e', ident, contractAfter, '--', '.', ...excludes])
    if (r.status === 0) {
      const hits = r.stdout.split('\n').filter(Boolean).map((l) => l.slice(contractAfter.length + 1))
      fail(RULES.identifierReferenced, `${ident} is still referenced in ${contractAfter}: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5})` : ''}`)
    } else if (r.status !== 1) {
      fail(RULES.unparseable, `git grep ${ident} ${contractAfter} failed: ${r.stderr.trim()}`)
    }
  }
  return problems
}

/** "file: statement N: rule: message" -- the one format every failure prints. */
export function formatProblem(file, p) {
  return `${file}: statement ${p.statement ?? 0}: ${p.rule}: ${p.message}`
}
